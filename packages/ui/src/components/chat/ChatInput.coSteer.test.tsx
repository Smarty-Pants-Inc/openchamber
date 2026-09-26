import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { setTimeout as sleep } from 'node:timers/promises';
import { mountedNativeComposer, shownActivity } from './composer/submit/__tests__/nativeComposer.fixture';
import { directory, session } from '@/sync/native-draft-fixture';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useConfigStore } from '@/stores/useConfigStore';
import { toast } from '@/components/ui';

// Co-steer (MVP 1 G5): while an ordinary session's agent works, Send sends. The server steers the message into the
// running turn; the page neither queues it, nor steers locally, nor pre-reads the status.
// The button above Stop is ComposerActionButtons' (ComposerActionButtons.coSteer.test.tsx); this fixture mocks the footer.
let mounted: Awaited<ReturnType<typeof mountedNativeComposer>> | undefined;
afterEach(async () => { await mounted?.dispose(); mounted = undefined; shownActivity.phase = 'idle'; });

const successToasts = () => (toast.success as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(call => String(call[0]));

async function ordinaryWorking(reply: () => Response) {
  const c = mounted = await mountedNativeComposer(false);
  const other: string[] = [];
  await act(async () => {
    useSessionUIStore.setState(state => ({ currentSessionId: session.id, currentSessionDirectory: directory,
      newSessionDraft: { ...state.newSessionDraft, open: false } }));
    useConfigStore.setState({ currentProviderId: 'p', currentModelId: 'm' });
    c.children.ensureChild(directory, { bootstrap: false }).setState({
      session: [{ ...session, title: 'org', ordinary: { generation: 'g1', sequence: 1, thinkingLevel: 'high',
        model: { providerID: 'p', modelID: 'm', name: 'Model' } } } as never],
      session_status: { [session.id]: { type: 'busy' } },
    });
    shownActivity.phase = 'busy';
  });
  c.handlers.prompt = async () => reply();
  const fixtureFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const path = new URL(new Request(input, init).url).pathname;
    if (path.endsWith('/session/status') || path.startsWith('/api/message-queue')) other.push(path);
    return fixtureFetch(input, init);
  };
  await act(async () => { c.rerender(); });
  await c.replace('steer this');
  return { c, other };
}

const steered = () => new Response(null, { status: 204, headers: { 'x-smarty-prompt-delivery': 'steer' } });

test('Send on a working ordinary session sends once, plainly, and says it was delivered while it works', async () => {
  const before = successToasts().length;
  const { c, other } = await ordinaryWorking(steered);
  await c.submit(); await act(async () => { await sleep(10); });
  expect(c.prompts()).toHaveLength(1);
  expect(other).toEqual([]);
  const body = await c.prompts()[0].json();
  expect(body.delivery).toBeUndefined();
  expect(body.parts.map((part: { text?: string }) => part.text)).toContain('steer this');
  expect(successToasts().slice(before)).toEqual(['Delivered to org while it works.']);
});

test('a prompt that started a turn says nothing extra', async () => {
  const before = successToasts().length;
  const { c } = await ordinaryWorking(() => new Response(null, { status: 204, headers: { 'x-smarty-prompt-delivery': 'prompt' } }));
  await c.submit(); await act(async () => { await sleep(10); });
  expect(c.prompts()).toHaveLength(1);
  expect(successToasts().slice(before)).toEqual([]);
});

test('a refused send keeps the session shown working and the text in the composer', async () => {
  const words = 'The session\'s terminal is busy. Nothing was sent.';
  const { c } = await ordinaryWorking(() => Response.json({ name: 'APIError',
    data: { message: words, isRetryable: false, code: 'smarty.prompt-blocked' } }, { status: 409 }));
  await c.submit(); await act(async () => { await sleep(10); });
  expect(c.prompts()).toHaveLength(1);
  expect(c.children.getChild(directory)?.getState().session_status[session.id]?.type).toBe('busy');
  expect(c.text()).toBe('steer this');
});
