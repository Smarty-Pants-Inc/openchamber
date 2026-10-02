import { afterEach, expect, test } from 'bun:test';
import { nativeDraftFixture, directory, session } from '@/sync/native-draft-fixture';
import { opencodeClient } from './client';

// smarty-code#126: a gateway with sessionVoiceStatus answers per session with a plain reason (code-voice #291).
let fixture: ReturnType<typeof nativeDraftFixture>, restore = () => {};
afterEach(() => { restore(); fixture?.dispose(); });
function gateway(capabilities: Record<string, number>, voice: () => Response | Promise<Response>) {
  fixture = nativeDraftFixture();
  fixture.handlers.health = async () => Response.json({ healthy: true, capabilities });
  const inner = globalThis.fetch;
  restore = () => { globalThis.fetch = inner; };
  globalThis.fetch = async (input, init) => {
    const url = new URL(new Request(input, init).url);
    if (url.pathname.endsWith(`/session/${session.id}/voice`)) {
      expect(url.searchParams.get('directory')).toBe(directory);
      return voice();
    }
    return inner(input, init);
  };
}
const ask = () => opencodeClient.sessionVoiceAvailability(session.id, directory);
const herdr = 'Voice calls work in sessions started from Code. This session was started in Herdr.';

test('per-session status: available, or not with the gateway\'s own sentence', async () => {
  gateway({ sessionVoiceStatus: 1 }, () => Response.json({ available: true }));
  expect(await ask()).toEqual({ available: true });
  restore(); fixture.dispose();
  gateway({ sessionVoiceStatus: 1 }, () => Response.json({ available: false, reason: herdr }));
  expect(await ask()).toEqual({ available: false, reason: herdr });
});

test('the exact gateway unknown answer preserves its retry hint, then availability can recover', async () => {
  const unknown = { available: false, reason: 'Voice is not available in this session right now. Try again in a moment.', retry: true };
  let reads = 0;
  gateway({ sessionVoiceStatus: 1 }, () => Response.json(reads++ === 0 ? unknown : { available: true }));
  expect(await ask()).toEqual(unknown);
  expect(await ask()).toEqual({ available: true });
  expect(reads).toBe(2);
});

for (const status of [404, 503]) {
  test(`health succeeds but HTTP ${status} status read rejects rather than declaring unavailability`, async () => {
    gateway({ sessionVoiceStatus: 1 }, () => Response.json({ message: 'Status unavailable' }, { status }));
    await expect(ask()).rejects.toThrow();
  });
}

test('health succeeds but a network status failure rejects', async () => {
  gateway({ sessionVoiceStatus: 1 }, () => { throw new Error('Synthetic status network failure'); });
  await expect(ask()).rejects.toThrow('Synthetic status network failure');
});

for (const body of [
  { available: false },
  { available: false, reason: herdr, retry: 'true' },
  { available: false, reason: herdr, extra: true },
]) {
  test(`health succeeds but malformed status ${JSON.stringify(body)} rejects`, async () => {
    gateway({ sessionVoiceStatus: 1 }, () => Response.json(body));
    await expect(ask()).rejects.toThrow();
  });
}

test('invalid status JSON rejects', async () => {
  gateway({ sessionVoiceStatus: 1 }, () => new Response('not JSON', { headers: { 'content-type': 'application/json' } }));
  await expect(ask()).rejects.toThrow();
});

test('an explicit false retry hint remains authoritative even with temporary-sounding reason text', async () => {
  const negative = { available: false, reason: 'Unknown session; try again in another session.', retry: false };
  gateway({ sessionVoiceStatus: 1 }, () => Response.json(negative));
  expect(await ask()).toEqual(negative);
});

test('an older gateway answers per directory; a gateway without voice answers not available, never asking per session', async () => {
  let asked = 0;
  gateway({ sessionVoice: 1 }, () => { asked++; return Response.json({ available: false, reason: herdr }); });
  expect(await ask()).toEqual({ available: true });
  restore(); fixture.dispose();
  gateway({}, () => { asked++; return Response.json({ available: true }); });
  expect(await ask()).toEqual({ available: false });
  expect(asked).toBe(0);
});
