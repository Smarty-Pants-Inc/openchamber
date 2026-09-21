import { expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import { z } from 'zod';
import { configureRuntimeUrlResolver } from '../../lib/runtime-url';
import { signInWithGoogle } from '../../lib/human-auth';

const signInBody = z.object({ provider: z.literal('google'), disableRedirect: z.boolean() });

// Actual Better Auth client and product runtime modules; only the HTTP response is synthetic.
test('delayed Google sign-in cannot navigate after runtime switch; current runtime can navigate', async () => {
  const originalWindow = globalThis.window;
  const fetchSpy = spyOn(globalThis, 'fetch');
  const window = new Window({ url: 'https://ui.example.test/' });
  Object.assign(globalThis, { window });
  const requests: { url: string; body: z.infer<typeof signInBody> }[] = [];
  try {
    for (const mode of ['switched', 'returned', 'current']) {
      const stale = mode !== 'current';
      window.location.href = 'https://ui.example.test/';
      configureRuntimeUrlResolver({ apiBaseUrl: 'https://runtime-a.example.test' });
      let release!: () => void, submitted!: () => void;
      const paused = new Promise<void>(resolve => { release = resolve; });
      const started = new Promise<void>(resolve => { submitted = resolve; });
      fetchSpy.mockImplementation(async (input, init) => {
        const request = new Request(input, init);
        const url = request.url;
        const body = signInBody.parse(await request.json());
        requests.push({ url, body });
        submitted(); await paused;
        return Response.json({ url: 'https://accounts.google.com/o/oauth2/v2/auth?state=fixture', redirect: !body.disableRedirect });
      });
      const pending = signInWithGoogle();
      await started;
      if (stale) configureRuntimeUrlResolver({ apiBaseUrl: 'https://runtime-b.example.test' });
      if (mode === 'returned') configureRuntimeUrlResolver({ apiBaseUrl: 'https://runtime-a.example.test' });
      release(); await pending;
      expect(window.location.origin).toBe(stale ? 'https://ui.example.test' : 'https://accounts.google.com');
    }
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(request.url).toBe('https://runtime-a.example.test/api/auth/sign-in/social');
      expect(request.body.provider).toBe('google');
      expect(request.body.disableRedirect).toBe(true);
    }
  } finally {
    fetchSpy.mockRestore();
    Object.assign(globalThis, { window: originalWindow });
    configureRuntimeUrlResolver({});
    await window.happyDOM.close();
  }
});
