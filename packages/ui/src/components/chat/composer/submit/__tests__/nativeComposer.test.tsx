import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { mountedNativeComposer, errors } from './nativeComposer.fixture';
import { deferred, directory, draft, session } from '@/sync/native-draft-fixture';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useInputStore } from '@/sync/input-store';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import { nativeCreationForDraft } from '@/sync/native-draft-creation';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { readChatDraft } from '@/lib/chatDraftPersistence';
import { browserDisplayName } from '@/lib/messages/displayName';

let mounted: Awaited<ReturnType<typeof mountedNativeComposer>> | undefined;
afterEach(async () => { await mounted?.dispose(); mounted = undefined; });
const settle = () => Bun.sleep(0);
const addInline = (text: string) => useInlineCommentDraftStore.getState().addDraft({ directory, sessionKey: 'draft' }, {
  source: 'file', fileLabel: 'context.ts', startLine: 1, endLine: 1, code: text, language: 'ts', text,
});

for (const persist of [false, true]) test(`mounted composer keeps newer text, confirmed mention and context on accepted transition; persistence ${persist}`, async () => {
  const c = mounted = await mountedNativeComposer(persist);
  const response = deferred<Response>(); c.handlers.prompt = async () => response.promise;
  await act(async () => { addInline('old inline'); });
  await c.replace('X'); await c.submit();
  expect(c.prompts()).toHaveLength(1);
  await c.replace('Y'); await c.mention('fresh.md');
  const newerFile = { ...useInputStore.getState().attachedFiles[0], id: 'new-file', filename: 'new.md' };
  const newerPart = { text: 'new synthetic', synthetic: true };
  await act(async () => {
    useInputStore.setState(state => ({ attachedFiles: [...state.attachedFiles, newerFile], pendingSyntheticParts: [...state.pendingSyntheticParts ?? [], newerPart] }));
    addInline('new inline');
    useSessionUIStore.setState(state => ({ newSessionDraft: { ...state.newSessionDraft,
      syntheticParts: [...state.newSessionDraft.syntheticParts ?? [], { text: 'new draft context', synthetic: true }] } }));
  });
  const text = c.text(); expect(text).toContain('@fresh.md');
  await act(async () => { response.resolve(new Response(null, { status: 204 })); await settle(); });
  expect(errors).toEqual([]);
  expect(useSessionUIStore.getState().currentSessionId).toBe(session.id);
  expect(c.text()).toBe(text);
  expect(useInputStore.getState().attachedFiles).toEqual([newerFile]);
  expect(useInputStore.getState().pendingSyntheticParts?.map(part => part.text)).toEqual(['new synthetic', 'new draft context']);
  expect(useInlineCommentDraftStore.getState().getDrafts({ directory, sessionKey: session.id }).map(part => part.text)).toEqual(['new inline']);
  expect(readChatDraft({ runtimeKey: c.runtimeA, directory, sessionId: null }).text).toBe('');
  if (persist) expect(readChatDraft({ runtimeKey: c.runtimeA, directory, sessionId: session.id }).text).toBe(text);
  expect(c.prompts()).toHaveLength(1); // No completion replay.
  await c.submit(); await act(settle);
  expect(c.prompts()).toHaveLength(2); expect(c.creates()).toHaveLength(1);
  const second = await c.prompts()[1].json();
  expect(second.parts.some((part: { type: string; url?: string }) => part.type === 'file' && part.url?.endsWith('/fresh.md'))).toBe(true);
  const texts = second.parts.filter((part: { type: string }) => part.type === 'text').map((part: { text: string }) => part.text).join('\n');
  expect(texts).toContain('Y'); expect(texts).toContain('new synthetic'); expect(texts).toContain('new inline');
  expect(texts).not.toContain('old inline'); expect(texts).not.toContain('input context'); expect(texts).not.toContain('draft-only context');
});

for (const navigation of ['target', 'runtime'] as const) test(`successful dispatched A prompt stays accepted through ${navigation} B and return`, async () => {
  const c = mounted = await mountedNativeComposer(true);
  const response = deferred<Response>(); c.handlers.prompt = async () => response.promise;
  await act(async () => { addInline('accepted inline A'); });
  await c.replace('accepted A'); await c.submit(); expect(c.prompts()).toHaveLength(1);
  await act(async () => {
    if (navigation === 'runtime') {
      c.switchRuntime('runtime-b');
      useSessionUIStore.setState({ newSessionDraft: { ...draft, selectedProjectId: 'b', directoryOverride: '/native-project-b' } });
    } else c.target('b', '/native-project-b');
  });
  await c.replace('untouched B');
  await act(async () => useInputStore.setState({ attachedFiles: [], pendingSyntheticParts: [{ text: 'B context' }] }));
  const bInlineTarget = { directory: '/native-project-b', sessionKey: 'draft' };
  await act(async () => useInlineCommentDraftStore.getState().addDraft(bInlineTarget, {
    source: 'file', fileLabel: 'B.ts', startLine: 1, endLine: 1, code: 'B', language: 'ts', text: 'B inline',
  }));
  const bInline = useInlineCommentDraftStore.getState().getDrafts(bInlineTarget);
  const bInput = useInputStore.getState(), bDraft = useSessionUIStore.getState().newSessionDraft;
  await act(async () => { response.resolve(new Response(null, { status: 204 })); await settle(); });
  expect(errors).toEqual([]); expect(c.text()).toBe('untouched B');
  expect(useInputStore.getState()).toBe(bInput); expect(useSessionUIStore.getState().newSessionDraft).toBe(bDraft);
  expect(useInlineCommentDraftStore.getState().getDrafts(bInlineTarget)).toBe(bInline);
  expect(useInlineCommentDraftStore.getState().getDrafts({ runtimeKey: c.runtimeA, directory, sessionKey: 'draft' })).toEqual([]);
  const record = nativeCreationForDraft(useSessionUIStore.getState().nativeDraftCreations, draft, c.runtimeA);
  expect(record?.status === 'created' && record.inputAccepted).toBe(true);
  await act(async () => {
    if (navigation === 'runtime') c.switchRuntime(c.runtimeA);
    else c.target('a', directory);
    await settle();
  });
  expect(useSessionUIStore.getState().currentSessionId).toBe(session.id);
  expect(c.text()).not.toContain('accepted A'); expect(c.prompts()).toHaveLength(1); expect(c.creates()).toHaveLength(1);
});

test('accepted A completion cannot consume a newer same-path draft with equal text', async () => {
  const c = mounted = await mountedNativeComposer(true);
  const response = deferred<Response>(); c.handlers.prompt = async () => response.promise;
  await c.replace('same text'); await c.submit(); expect(c.prompts()).toHaveLength(1);
  await act(async () => {
    useSessionUIStore.setState({ newSessionDraft: { ...draft, draftId: draft.draftId + 1 } });
    useInputStore.setState({ attachedFiles: [], pendingSyntheticParts: [{ text: 'new draft context' }] });
    addInline('new draft inline');
  });
  const newerDraft = useSessionUIStore.getState().newSessionDraft, input = useInputStore.getState();
  const inline = useInlineCommentDraftStore.getState().getDrafts({ directory, sessionKey: 'draft' });
  await act(async () => { response.resolve(new Response(null, { status: 204 })); await settle(); });
  expect(errors).toEqual([]); expect(c.text()).toBe('same text');
  expect(useSessionUIStore.getState().newSessionDraft).toBe(newerDraft);
  expect(useInputStore.getState()).toBe(input);
  expect(useInlineCommentDraftStore.getState().getDrafts({ directory, sessionKey: 'draft' })).toBe(inline);
  expect(c.prompts()).toHaveLength(1); expect(c.creates()).toHaveLength(1);
});

test('mounted named whitespace command refuses before native history or composer consumption', async () => {
  const c = mounted = await mountedNativeComposer(false);
  browserDisplayName.apply('Test label');
  await c.replace(' /btw question');
  const input = useInputStore.getState(), before = c.requests.length;
  await c.submit();
  expect(errors).toHaveLength(1); expect(c.text()).toBe(' /btw question');
  expect(useInputStore.getState()).toBe(input); expect(c.requests).toHaveLength(before);
  expect(c.creates()).toHaveLength(1); expect(c.prompts()).toHaveLength(0);
});

for (const preparation of ['settings', 'snippet', 'magic'] as const) test(`real composer ${preparation} await cannot fall through from native A to healthy legacy B`, async () => {
  const c = mounted = await mountedNativeComposer(true);
  const pending = deferred<Response>(); let entered = false;
  c.handlers[preparation] = async () => { entered = true; return pending.promise; };
  await c.replace(preparation === 'magic' ? '/plan-feature X' : preparation === 'snippet' ? 'X #snippet' : 'X');
  await c.submit(); expect(entered).toBe(true); expect(c.prompts()).toHaveLength(0);
  await act(async () => {
    c.switchRuntime('legacy-b');
    c.handlers.health = async () => Response.json({ healthy: true });
    useSessionUIStore.setState({ newSessionDraft: { ...draft } }); // Same-path project on healthy capability-absent B.
    await settle();
  });
  await act(async () => {
    pending.resolve(Response.json(preparation === 'magic' ? { version: 1, overrides: {} } : preparation === 'snippet' ? { text: 'expanded X' } : {}));
    await settle();
  });
  expect(getRuntimeKey()).toBe('legacy-b'); expect(c.creates()).toHaveLength(1); expect(c.prompts()).toHaveLength(0);
  expect(errors).toHaveLength(1);
  const owner = nativeCreationForDraft(useSessionUIStore.getState().nativeDraftCreations, draft, c.runtimeA);
  expect(owner?.status === 'created' && owner.session.id).toBe(session.id);
  expect(owner?.status === 'created' && owner.inputAccepted).not.toBe(true);
  await act(async () => { c.switchRuntime(c.runtimeA); await settle(); });
  expect(c.text()).toContain('X'); expect(useSessionUIStore.getState().newSessionDraft.open).toBe(true);
});
