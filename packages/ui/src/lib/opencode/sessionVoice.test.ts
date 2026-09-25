import { afterEach, expect, test } from 'bun:test';
import { nativeDraftFixture, directory, session } from '@/sync/native-draft-fixture';
import { opencodeClient } from './client';

// smarty-code#126: a gateway with sessionVoiceStatus answers per session with a plain reason (code-voice #291).
let fixture: ReturnType<typeof nativeDraftFixture>, restore = () => {};
afterEach(() => { restore(); fixture?.dispose(); });
function gateway(capabilities: Record<string, number>, voice: () => Response) {
  fixture = nativeDraftFixture();
  fixture.handlers.health = async () => Response.json({ healthy: true, capabilities });
  const inner = globalThis.fetch;
  restore = () => { globalThis.fetch = inner; };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url);
    if (url.pathname.endsWith(`/session/${session.id}/voice`)) {
      expect(url.searchParams.get('directory')).toBe(directory);
      return voice();
    }
    return inner(input, init);
  }) as typeof fetch;
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

test('a failed or malformed status read is "not available" with no reason (the control shows a generic one)', async () => {
  gateway({ sessionVoiceStatus: 1 }, () => Response.json({ message: 'Unknown Pi session' }, { status: 404 }));
  expect(await ask()).toEqual({ available: false });
  restore(); fixture.dispose();
  gateway({ sessionVoiceStatus: 1 }, () => Response.json({ available: false }));
  expect(await ask()).toEqual({ available: false });
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
