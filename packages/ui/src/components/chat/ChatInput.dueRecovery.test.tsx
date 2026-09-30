import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import type { TransactionSpec } from '@codemirror/state';
import { setTimeout as sleep } from 'node:timers/promises';
import { mountedNativeComposer, shownActivity } from './composer/submit/__tests__/nativeComposer.fixture';
import { deferred, directory, session } from '@/sync/native-draft-fixture';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useConfigStore } from '@/stores/useConfigStore';
import { useInputStore } from '@/sync/input-store';
import { createChatDraftIdentity, readChatDraft } from '@/lib/chatDraftPersistence';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { sendUnconfirmed } from '@/lib/sendUnconfirmed';
import { reloadHeld } from '@/lib/newBuildReload';

// openchamber#375 review 4, P1 1: sends to session S that come due while session T is shown come back when S is shown
// again, all of them, after S's own saved draft, in the composer AND in S's saved draft (a restore never reads the stale
// editor document, and the flush runs once S's draft is in the editor).
let mounted: Awaited<ReturnType<typeof mountedNativeComposer>> | undefined;
let was = sendUnconfirmed.ms;
afterEach(async () => { await mounted?.dispose(); mounted = undefined; shownActivity.phase = 'idle'; sendUnconfirmed.ms = was; });

const other = { ...session, id: '01234567-1234-4234-9234-0123456789ff', title: 'other' };
const savedS = () => readChatDraft(createChatDraftIdentity(getRuntimeKey(), directory, session.id)).text;
const until = async (ok: () => boolean, ms = 20_000) => { for (const end = Date.now() + ms; !ok() && Date.now() < end; ) await act(async () => { await sleep(25); }); expect(ok()).toBe(true); };

async function heldSession(parts?: ReturnType<typeof useInputStore.getState>['attachedFiles']) {
  was = sendUnconfirmed.ms; sendUnconfirmed.ms = 1_500;
  const c = mounted = await mountedNativeComposer(true);
  await act(async () => {
    useSessionUIStore.setState(state => ({ currentSessionId: session.id, currentSessionDirectory: directory,
      newSessionDraft: { ...state.newSessionDraft, open: false } }));
    useConfigStore.setState({ currentProviderId: 'p', currentModelId: 'm' });
    // SAFETY: the fixture's session records carry the fields ChatInput reads; `ordinary` is the gateway's extension.
    c.children.ensureChild(directory, { bootstrap: false }).setState({
      session: [{ ...session, title: 'org', ordinary: { generation: 'g1', sequence: 1, thinkingLevel: 'high',
        model: { providerID: 'p', modelID: 'm', name: 'Model' } } } as never, other as never],
      session_status: { [session.id]: { type: 'idle' } },
    });
  });
  const held = deferred<Response>();
  c.handlers.prompt = async () => held.promise;
  await act(async () => { c.rerender(); });
  // Plain text only: the fixture's file and context part are not what this is about.
  await act(async () => { useInputStore.getState().setAttachedFiles([]); useInputStore.getState().setPendingSyntheticParts([]); });
  if (parts) await act(async () => { useInputStore.getState().setAttachedFiles(parts); });
  return { c, held };
}

// The return to S with an editor whose document lags the composer state (as CodeMirror's controlled-value effect does,
// a render behind): a restore that read the editor document saw the other session's empty text and replaced S's draft.
const showWithLaggingEditor = async (c: NonNullable<typeof mounted>, id: string) => {
  const view = c.editor(); const dispatch = view.dispatch;
  // The composer dispatches specs only; a rewrite of the document is applied 40 ms late, as a whole-document replace.
  const lagging = (...specs: TransactionSpec[]) => {
    const next = view.state.update(...specs).state.doc.toString();
    if (next === view.state.doc.toString()) { dispatch.apply(view, specs); return; }
    setTimeout(() => dispatch.call(view, { changes: { from: 0, to: view.state.doc.length, insert: next } }), 40);
  };
  Object.assign(view, { dispatch: lagging });
  try { await show(c, id); await act(async () => { await sleep(200); }); } finally { Object.assign(view, { dispatch }); }
};
const show = async (c: NonNullable<typeof mounted>, id: string) => {
  await act(async () => { useSessionUIStore.setState({ currentSessionId: id }); });
  await act(async () => { c.rerender(); await sleep(0); });
};

test('two held sends to S due while T is shown: back on S, the composer and the saved draft hold both, in order', async () => {
  const { c, held } = await heldSession();
  await c.replace('first held text'); await c.submit(); await until(() => c.prompts().length === 1);
  await c.replace('second held text'); await c.submit(); await until(() => c.prompts().length === 2);
  expect(c.text()).toBe('');
  await show(c, other.id);
  await act(async () => { await sleep(1_900); }); // Both come due while T is shown.
  expect(c.text()).toBe('');
  await show(c, session.id);
  await until(() => c.text().includes('first held text') && c.text().includes('second held text'));
  expect(c.text().indexOf('first held text')).toBeLessThan(c.text().indexOf('second held text'));
  await until(() => savedS().includes('first held text') && savedS().includes('second held text'));
  // Refused after it came back: the text is still there (review step 4).
  await act(async () => { held.resolve(Response.json({ name: 'APIError', data: { message: 'Nothing was sent.', isRetryable: false } }, { status: 409 })); await sleep(20); });
  expect(c.text()).toContain('first held text');
  expect(c.text()).toContain('second held text');
}, 30_000);

// openchamber#375 review 5, P1: a refusal while T is shown makes S's send due; a new-build reload then must not lose it.
test('a held send to S refused while T is shown: a reload waits or S\'s saved draft holds it; back on S it shows once', async () => {
  const { c, held } = await heldSession();
  await c.replace('the refused text'); await c.submit(); await until(() => c.prompts().length === 1);
  await show(c, other.id);
  await act(async () => { held.resolve(Response.json({ name: 'APIError', data: { message: 'Nothing was sent.', isRetryable: false } }, { status: 409 })); await sleep(50); });
  expect(c.text()).toBe('');
  // The reload decision (sync-context): held, or the text is where a reload keeps it.
  expect(reloadHeld() || savedS().includes('the refused text')).toBe(true);
  expect(reloadHeld()).toBe(true); // Its attachments and context live only in memory: the reload waits.
  expect(savedS()).toBe('the refused text'); // Kept across a reload or an unmount, not only in memory.
  await show(c, session.id);
  await until(() => c.text().includes('the refused text'));
  await act(async () => { await sleep(300); });
  expect(c.text().split('the refused text').length - 1).toBe(1);
  expect(savedS().split('the refused text').length - 1).toBe(1);
}, 30_000);

test('a held send plus a newer draft typed in S before leaving: back on S, both are kept', async () => {
  const { c } = await heldSession();
  await c.replace('the held text'); await c.submit(); await until(() => c.prompts().length === 1);
  await c.replace('a newer draft');
  await show(c, other.id);
  await act(async () => { await sleep(1_900); });
  await showWithLaggingEditor(c, session.id);
  await until(() => c.text().includes('the held text'));
  expect(c.text()).toContain('a newer draft');
  expect(c.text().indexOf('a newer draft')).toBeLessThan(c.text().indexOf('the held text'));
  await until(() => savedS().includes('a newer draft') && savedS().includes('the held text'));
}, 30_000);

// smarty-code#962 (2): two given-back texts joined in S's composer; the first is accepted late. Only its own copy goes:
// the second stays, in the composer and in S's saved draft (never a double send of the first).
test('two due texts joined, the first accepted late: only the second remains in the composer and the saved draft', async () => {
  const { c } = await heldSession();
  const replies = [deferred<Response>(), deferred<Response>()]; let n = 0;
  c.handlers.prompt = async () => replies[n++].promise;
  await c.replace('first held text'); await c.submit(); await until(() => c.prompts().length === 1);
  await c.replace('second held text'); await c.submit(); await until(() => c.prompts().length === 2);
  await show(c, other.id);
  await act(async () => { await sleep(1_900); });
  await show(c, session.id);
  await until(() => c.text().includes('first held text') && c.text().includes('second held text'));
  await until(() => savedS().includes('first held text') && savedS().includes('second held text'));
  await act(async () => { replies[0].resolve(new Response(null, { status: 204, headers: { 'x-smarty-prompt-delivery': 'prompt' } })); await sleep(50); });
  await until(() => !c.text().includes('first held text'));
  expect(c.text().trim()).toBe('second held text');
  await until(() => savedS().trim() === 'second held text');
}, 30_000);

// smarty-code#962 review r1: a late acceptance removes only the copy its recovery joined, intact where it was joined.
const accept = () => new Response(null, { status: 204, headers: { 'x-smarty-prompt-delivery': 'prompt' } });
async function dueWhileAway(c: NonNullable<typeof mounted>, texts: string[], newer?: string) {
  const replies = texts.map(() => deferred<Response>()); let n = 0;
  c.handlers.prompt = async () => replies[n++].promise;
  for (const [i, text] of texts.entries()) { await c.replace(text); await c.submit(); await until(() => c.prompts().length === i + 1); }
  if (newer) await c.replace(newer);
  await show(c, other.id);
  await act(async () => { await sleep(1_900); });
  await show(c, session.id);
  await until(() => texts.every(text => c.text().includes(text)) && texts.every(text => savedS().includes(text)));
  return replies;
}

test('the given-back text edited by the person: its late acceptance removes nothing, shown or not', async () => {
  const { c } = await heldSession();
  const [reply] = await dueWhileAway(c, ['first held text']);
  await c.replace('first held text\nunsent continuation');
  await until(() => savedS() === 'first held text\nunsent continuation');
  await act(async () => { reply.resolve(accept()); await sleep(100); });
  expect(c.text()).toBe('first held text\nunsent continuation');
  expect(savedS()).toBe('first held text\nunsent continuation');
}, 30_000);

test('the given-back text edited, then S not shown at its late acceptance: the saved draft keeps the edit', async () => {
  const { c } = await heldSession();
  const [reply] = await dueWhileAway(c, ['first held text']);
  await c.replace('first held text\nunsent continuation');
  await show(c, other.id);
  await until(() => savedS() === 'first held text\nunsent continuation');
  await act(async () => { reply.resolve(accept()); await sleep(100); });
  expect(savedS()).toBe('first held text\nunsent continuation');
  await show(c, session.id);
  await until(() => c.text() === 'first held text\nunsent continuation');
}, 30_000);

test('a newer draft holding the same text: the late acceptance removes the joined copy, never the newer draft', async () => {
  const { c } = await heldSession();
  const [reply] = await dueWhileAway(c, ['first held text'], 'first held text\n\nunsent continuation');
  expect(c.text().split('first held text').length - 1).toBe(2);
  await act(async () => { reply.resolve(accept()); await sleep(100); });
  await until(() => c.text().trim() === 'first held text\n\nunsent continuation');
  await until(() => savedS().trim() === 'first held text\n\nunsent continuation');
}, 30_000);

test('two joined texts both accepted in one tick, with a newer draft: only the newer draft remains', async () => {
  const { c } = await heldSession();
  const replies = await dueWhileAway(c, ['first held text', 'second held text'], 'a newer draft');
  await act(async () => { replies[0].resolve(accept()); replies[1].resolve(accept()); await sleep(100); });
  await until(() => c.text().trim() === 'a newer draft');
  await until(() => savedS().trim() === 'a newer draft');
}, 30_000);

test('two joined texts both accepted in one tick: the composer and the saved draft are empty', async () => {
  const { c } = await heldSession();
  const replies = await dueWhileAway(c, ['first held text', 'second held text']);
  await act(async () => { replies[0].resolve(accept()); replies[1].resolve(accept()); await sleep(100); });
  await until(() => c.text().trim() === '');
  await until(() => savedS().trim() === '');
}, 30_000);

// smarty-code#962 review r2 1: a submitted text ending in newlines, joined intact, still goes on its late acceptance.
for (const tail of ['\n', '\n\n']) {
  const first = `first held text${tail}`;
  test(`a joined text ending in ${tail.length} newline(s), accepted late while shown: only the other remains`, async () => {
    const { c } = await heldSession();
    const replies = await dueWhileAway(c, [first, 'second held text']);
    await act(async () => { replies[0].resolve(accept()); await sleep(100); });
    await until(() => c.text().trim() === 'second held text');
    await until(() => savedS().trim() === 'second held text');
  }, 30_000);
  test(`a joined text ending in ${tail.length} newline(s), accepted late off-screen: only the other remains`, async () => {
    const { c } = await heldSession();
    const replies = await dueWhileAway(c, [first, 'second held text']);
    await show(c, other.id);
    await act(async () => { replies[0].resolve(accept()); await sleep(100); });
    expect(savedS().trim()).toBe('second held text');
    await show(c, session.id);
    await until(() => c.text().trim() === 'second held text');
  }, 30_000);
}

// smarty-code#962 review r2 2: an attachment-only send given back, then accepted late: its file goes, a newer one stays.
test('an attachment-only send given back, accepted late: its file chip goes, a newly added file stays', async () => {
  const file = { id: 'file-held', filename: 'held.md', mimeType: 'text/plain', dataUrl: 'data:text/plain;base64,aGVsZA==',
    source: 'local' as const, file: new File(['held'], 'held.md', { type: 'text/plain' }), size: 4 };
  const { c, held } = await heldSession([file]);
  await c.replace(''); await c.submit(); await until(() => c.prompts().length === 1);
  await until(() => useInputStore.getState().attachedFiles.length === 0);
  await until(() => useInputStore.getState().attachedFiles.some(f => f.id === 'file-held')); // The watchdog gives it back.
  const newer = { ...file, id: 'file-newer', filename: 'newer.md' };
  await act(async () => { useInputStore.getState().setAttachedFiles([...useInputStore.getState().attachedFiles, newer]); });
  await act(async () => { held.resolve(accept()); await sleep(100); });
  await until(() => !useInputStore.getState().attachedFiles.some(f => f.id === 'file-held'));
  expect(useInputStore.getState().attachedFiles.map(f => f.id)).toEqual(['file-newer']);
}, 30_000);
