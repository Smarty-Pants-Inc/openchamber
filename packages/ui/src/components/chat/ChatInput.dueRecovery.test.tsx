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

// openchamber#375 review 4, P1 1: sends to session S that come due while session T is shown come back when S is shown
// again, all of them, after S's own saved draft, in the composer AND in S's saved draft (a restore never reads the stale
// editor document, and the flush runs once S's draft is in the editor).
let mounted: Awaited<ReturnType<typeof mountedNativeComposer>> | undefined;
let was = sendUnconfirmed.ms;
afterEach(async () => { await mounted?.dispose(); mounted = undefined; shownActivity.phase = 'idle'; sendUnconfirmed.ms = was; });

const other = { ...session, id: '01234567-1234-4234-9234-0123456789ff', title: 'other' };
const savedS = () => readChatDraft(createChatDraftIdentity(getRuntimeKey(), directory, session.id)).text;
const until = async (ok: () => boolean, ms = 20_000) => { for (const end = Date.now() + ms; !ok() && Date.now() < end; ) await act(async () => { await sleep(25); }); expect(ok()).toBe(true); };

async function heldSession() {
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
