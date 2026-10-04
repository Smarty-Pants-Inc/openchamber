import { expect, test } from 'bun:test';
import { act } from 'react';
import { configureRuntimeUrlResolver } from '@/lib/runtime-url';
import { recoveryFixture, resume, target } from './365-recovery-client.fixture';
import { operation, recoveryHttp, stateReply } from './365-recovery-http.fixture';

for (const retirement of ['runtime', 'record'] as const) {
  test(`deferred operation read rechecks original ${retirement} authority before transport resolution`, async () => {
    const f = await recoveryFixture(), b = await recoveryHttp();
    let armed = false, queued = false, switched = false;
    try {
      // The injected runtime URL is a real browser input. Queue its change during the final outer
      // scope observation, after that observation reads A but before the deadline helper invokes work.
      Object.defineProperty(f.dom.window, '__OPENCHAMBER_API_BASE_URL__', { configurable: true, get: () => {
        if (armed) {
          armed = false; queued = true;
          queueMicrotask(() => {
            switched = true;
            if (retirement === 'record') resume.resetContinueForPage();
            else {
              Object.defineProperty(f.dom.window, '__OPENCHAMBER_API_BASE_URL__', { value: b.base, configurable: true });
              configureRuntimeUrlResolver({ apiBaseUrl: b.base });
            }
          });
        }
        return f.base;
      } });
      resume.resumeTiming.poll = async () => { armed = true; };
      // If the defective code dispatches, settle that actual HTTP response so the assertion is not a timeout.
      const transport = retirement === 'runtime' ? b : f.raw;
      void transport.read.take().then(receipt => receipt.reply(stateReply('cancelled')));
      const pending = f.start(() => resume.continueEndedSession(target.directory, target.sessionID));
      const post = await f.post.take(); post.reply(stateReply('starting', f.requestId(post)));
      await f.settle(pending);
      expect(queued).toBe(true); expect(switched).toBe(true);
      expect([...f.requests, ...b.requests].filter(r => r.url.pathname.endsWith(operation('ready').operationId))).toHaveLength(0);
      expect(f.requests.filter(r => r.url.pathname.endsWith('/resume'))).toHaveLength(1);
      expect(b.requests.filter(r => r.url.pathname.endsWith('/resume'))).toHaveLength(0);
      if (retirement === 'runtime') {
        Object.defineProperty(f.dom.window, '__OPENCHAMBER_API_BASE_URL__', { value: f.base, configurable: true });
        configureRuntimeUrlResolver({ apiBaseUrl: f.base }); await f.render();
        expect(f.status()).toMatchObject({ status: 'unknown', requestId: f.requestId(post), operationId: operation('ready').operationId });
        await f.settle(f.start(() => resume.continueEndedSession(target.directory, target.sessionID)));
        expect(f.requests.filter(r => r.url.pathname.endsWith('/resume'))).toHaveLength(1);
      } else expect(f.status()).toBeUndefined();
    } finally {
      armed = false;
      Object.defineProperty(f.dom.window, '__OPENCHAMBER_API_BASE_URL__', { value: f.base, configurable: true });
      configureRuntimeUrlResolver({ apiBaseUrl: f.base });
      await act(async () => { await b.close(); }); await f.close();
    }
  }, 8000);
}
