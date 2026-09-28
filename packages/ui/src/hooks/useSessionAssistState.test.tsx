import React, { act } from 'react';
import { Window } from 'happy-dom';
import { expect, mock, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import type { AssistantMessage, Message, Session, UserMessage } from '@opencode-ai/sdk/v2';

// openchamber#224 review: consumer-level checks of the two readers of "the session's last message". A voice call note
// (smarty-voice-state, clientRole 'system-note') after a reply must not hide that reply's assist, nor clear the
// unanswered-question notice; a newer real message still invalidates the assist. The no-reply state cannot be reached
// with real input on a candidate (Pi always answers; Stop records an aborted reply), so it is set up here.
let messages: Message[] = [];
const listeners = new Set<() => void>();
const store = { getState: () => ({ message: { s: messages } }), subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); } };
let session: Session | null = null;
mock.module('@/sync/sync-context', () => ({
  useDirectoryStore: () => store, useSession: () => session, useSessionStatus: () => ({ type: 'idle' }),
}));
mock.module('@/sync/notification-store', () => ({ useLatestSessionError: () => null }));
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
const { useSessionAssistState } = await import('./useSessionAssist');
const { SessionErrorNotice } = await import('@/components/chat/SessionErrorNotice');

const now = Date.now();
const user = (id: string, created: number): UserMessage => ({ id, sessionID: 's', role: 'user', time: { created }, agent: 'build', model: { providerID: 'p', modelID: 'm' } });
const reply = (id: string, created: number): AssistantMessage => ({ id, sessionID: 's', role: 'assistant', time: { created, completed: created + 1 }, parentID: 'u1',
  modelID: 'm', providerID: 'p', mode: 'build', agent: 'build', path: { cwd: '/', root: '/' }, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } });
const note = (id: string, created: number): Message => ({ ...reply(id, created), providerID: 'pi-native', modelID: 'system-note', ...{ clientRole: 'system-note' } });
const withAssist = (forMessageID: string): Session => ({ id: 's', slug: 's', projectID: 'p', directory: '/', title: 't', version: '1',
  time: { created: 0, updated: 0 }, ...{ metadata: { openchamber: { assist: { recap: 'The recap.', suggestion: 'Next, run the tests.', forMessageID, generatedAt: 1 } } } } });

async function mounted(render: () => React.ReactNode, run: (html: () => string) => Promise<void>) {
  const win = new Window({ url: 'http://localhost' });
  const values = { window: win, document: win.document, navigator: win.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const host = document.createElement('div'); // The global document is happy-dom's (defined just above).
  const root = createRoot(host);
  try {
    await act(async () => root.render(render()));
    await run(() => host.innerHTML);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
    await win.happyDOM.close();
  }
}
const change = (next: Message[]) => act(async () => { messages = next; for (const fn of listeners) fn(); });

test('the assist survives a voice call note after its reply; a newer real message still invalidates it', async () => {
  let state: ReturnType<typeof useSessionAssistState> | null = null;
  const Probe = () => { state = useSessionAssistState('s'); return null; };
  session = withAssist('a1');
  messages = [user('u1', now - 120_000), reply('a1', now - 110_000)];
  await mounted(() => <Probe />, async () => {
    expect(state!.suggestion).toBe('Next, run the tests.');
    expect(state!.visibleRecap).toBe('The recap.'); // The quiet minute has passed.
    await change([...messages, note('n1', now - 100_000)]); // A call started after the reply.
    expect(state!.suggestion).toBe('Next, run the tests.');
    expect(state!.visibleRecap).toBe('The recap.');
    await change([...messages, user('u2', now - 50_000)]); // A newer real message: the payload is stale.
    expect(state!.suggestion).toBeNull();
    expect(state!.visibleRecap).toBeNull();
    await change([...messages, reply('a2', now - 40_000), note('n2', now - 30_000)]); // A newer reply too.
    expect(state!.assist).toBeNull(); // The payload was for a1.
  });
});

test('the unanswered-question notice stays when a voice call note follows the unanswered message', async () => {
  session = null;
  messages = [user('u1', now - 60_000), reply('a1', now - 55_000), user('u2', now - 20_000)]; // u2 got no reply.
  await mounted(() => <SessionErrorNotice sessionId="s" />, async (html) => {
    expect(html()).toContain('chat.sessionError.noReply');
    await change([...messages, note('n1', now - 10_000)]);
    expect(html()).toContain('chat.sessionError.noReply');
    await change([...messages, reply('a2', now - 5_000)]); // A real reply clears it.
    expect(html()).not.toContain('chat.sessionError.noReply');
  });
});
