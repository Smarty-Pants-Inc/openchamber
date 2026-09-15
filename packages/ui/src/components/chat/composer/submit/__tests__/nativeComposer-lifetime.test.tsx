import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { mountedNativeComposer, errors } from './nativeComposer.fixture';
import { deferred, directory, draft, session } from '@/sync/native-draft-fixture';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useInputStore } from '@/sync/input-store';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import { nativeCreationForDraft } from '@/sync/native-draft-creation';
import { readChatDraft } from '@/lib/chatDraftPersistence';

let mounted: Awaited<ReturnType<typeof mountedNativeComposer>> | undefined;
afterEach(async () => { await mounted?.dispose(); mounted = undefined; });
const settle = () => Bun.sleep(0);
const addInline = (path: string, text: string) => useInlineCommentDraftStore.getState().addDraft({ directory: path, sessionKey: 'draft' }, {
  source: 'file', fileLabel: 'context.ts', startLine: 1, endLine: 1, code: text, language: 'ts', text,
});

for (const newer of [false, true]) test(`epoch teardown/remount completes original A input, newer input ${newer}`, async () => {
  const c = mounted = await mountedNativeComposer(true);
  const response = deferred<Response>(); c.handlers.prompt = async () => response.promise;
  await act(async () => { addInline(directory, 'submitted inline'); });
  await c.replace('X'); await c.submit(); expect(c.prompts()).toHaveLength(1);
  let remaining = '';
  if (newer) {
    await c.replace('Y'); await c.mention('fresh.md'); remaining = c.text();
    await act(async () => { addInline(directory, 'remaining inline'); });
  }
  const oldEditor = c.editor();
  await act(async () => {
    c.switchRuntime(`${c.runtimeA}-b`);
    useSessionUIStore.setState({ currentSessionId: null, newSessionDraft: { ...draft, selectedProjectId: 'b', directoryOverride: '/native-project-b' } });
    c.remount();
  });
  expect(c.editor()).not.toBe(oldEditor); expect(oldEditor.dom.isConnected).toBe(false);
  await c.replace('B input');
  await act(async () => {
    useInputStore.setState({ attachedFiles: [], pendingSyntheticParts: [{ text: 'B synthetic' }] });
    addInline('/native-project-b', 'B inline');
  });
  const bInput = useInputStore.getState(), bDraft = useSessionUIStore.getState().newSessionDraft;
  const bInline = useInlineCommentDraftStore.getState().getDrafts({ directory: '/native-project-b', sessionKey: 'draft' });
  await act(async () => { response.resolve(new Response(null, { status: 204 })); await settle(); });
  expect(errors).toEqual([]); expect(c.text()).toBe('B input');
  expect(useInputStore.getState()).toBe(bInput); expect(useSessionUIStore.getState().newSessionDraft).toBe(bDraft);
  expect(useInlineCommentDraftStore.getState().getDrafts({ directory: '/native-project-b', sessionKey: 'draft' })).toBe(bInline);
  const accepted = nativeCreationForDraft(useSessionUIStore.getState().nativeDraftCreations, draft, c.runtimeA);
  expect(accepted?.status === 'created' && accepted.inputAccepted).toBe(true);
  const pendingA = readChatDraft({ runtimeKey: c.runtimeA, directory, sessionId: null });
  expect(pendingA.text).toBe(remaining);
  if (newer) expect(pendingA.confirmedMentions.has('fresh.md')).toBe(true);
  expect(useInlineCommentDraftStore.getState().getDrafts({ runtimeKey: c.runtimeA, directory, sessionKey: session.id }).map(item => item.text))
    .toEqual(newer ? ['remaining inline'] : []);
  await act(async () => { c.switchRuntime(c.runtimeA); c.remount(); await settle(); });
  expect(useSessionUIStore.getState().currentSessionId).toBe(session.id); expect(c.text()).toBe(remaining);
  expect(readChatDraft({ runtimeKey: c.runtimeA, directory, sessionId: null }).text).toBe('');
  if (newer) {
    expect(readChatDraft({ runtimeKey: c.runtimeA, directory, sessionId: session.id }).confirmedMentions.has('fresh.md')).toBe(true);
  }
  expect(c.prompts()).toHaveLength(1); expect(c.creates()).toHaveLength(1);
  if (newer) {
    // The fixture omits SyncProvider; perform its normal selected-owner history read before another explicit Send.
    await c.loader.ensure({ directory, sessionID: session.id }, { reason: 'navigation' });
    await c.submit(); expect(c.prompts()).toHaveLength(2); expect(c.creates()).toHaveLength(1);
    const body = await c.prompts()[1].json();
    expect(body.parts.some((part: { type: string; url?: string }) => part.type === 'file' && part.url?.endsWith('/fresh.md'))).toBe(true);
    expect(body.parts.some((part: { text?: string }) => part.text?.includes('remaining inline'))).toBe(true);
    expect(body.parts.some((part: { text?: string }) => part.text?.includes('submitted inline'))).toBe(false);
  }
});

test('O completion preserves replacement N at P after N navigates to Q, including equal text and confirmed mention', async () => {
  const c = mounted = await mountedNativeComposer(true);
  const response = deferred<Response>(); c.handlers.prompt = async () => response.promise;
  await c.replace('X'); await c.mention('kept.md'); const submitted = c.text();
  await c.submit(); expect(c.prompts()).toHaveLength(1);
  await act(async () => useSessionUIStore.getState().openNewSessionDraft({ target: 'project', selectedProjectId: 'a', directoryOverride: directory }));
  const n = useSessionUIStore.getState().newSessionDraft; expect(n.draftId).not.toBe(draft.draftId);
  await c.replace('X'); await c.mention('kept.md'); expect(c.text()).toBe(submitted);
  await act(async () => { addInline(directory, 'N inline'); c.target('b', '/native-project-b'); });
  await c.replace('Q input');
  const p = { runtimeKey: c.runtimeA, directory, sessionId: null };
  expect(readChatDraft(p).text).toBe(submitted); expect(readChatDraft(p).confirmedMentions.has('kept.md')).toBe(true);
  await act(async () => { response.resolve(new Response(null, { status: 204 })); await settle(); });
  expect(errors).toEqual([]); expect(c.text()).toBe('Q input');
  expect(useSessionUIStore.getState().newSessionDraft.draftId).toBe(n.draftId);
  expect(readChatDraft(p).text).toBe(submitted); expect(readChatDraft(p).confirmedMentions.has('kept.md')).toBe(true);
  expect(useInlineCommentDraftStore.getState().getDrafts({ directory, sessionKey: session.id })).toEqual([]);
  await act(async () => { c.target('a', directory); await settle(); });
  expect(c.text()).toBe(submitted); expect(useSessionUIStore.getState().newSessionDraft.draftId).toBe(n.draftId);
  expect(useSessionUIStore.getState().currentSessionId).toBeNull();
  expect(useInlineCommentDraftStore.getState().getDrafts({ directory, sessionKey: 'draft' }).map(item => item.text)).toEqual(['N inline']);
  const original = nativeCreationForDraft(useSessionUIStore.getState().nativeDraftCreations, draft, c.runtimeA);
  expect(original?.status === 'created' && original.inputAccepted).toBe(true);
  expect(nativeCreationForDraft(useSessionUIStore.getState().nativeDraftCreations, n, c.runtimeA)).toBeNull();
  expect(c.prompts()).toHaveLength(1); expect(c.creates()).toHaveLength(1);
});
