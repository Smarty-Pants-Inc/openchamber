import { expect, test } from 'bun:test';
import { act } from 'react';
import { setTimeout as sleep } from 'node:timers/promises';
import { deferred } from '@/sync/native-draft-fixture';
import { abandonedNativeCreations } from '@/sync/native-draft-control';
import { nativeCreationI18n } from '@/lib/i18n/messages/native-creation.i18n';
import { mountedStart523 } from './startRelease523.fixture';

const refused = 'This start already finished; nothing to abandon';
for (const returned of [true, false]) for (const outcome of ['409', 'malformed', 'cancelled'] as const) {
  test(`late ${outcome} Stop ${returned ? 'while B is visible then return A' : 'staying on A'} settles its control truthfully`, async () => {
    const c = await mountedStart523('create', -1);
    const response = deferred<Response>(), entered = deferred<void>();
    let original: ReturnType<typeof c.server.operation> | undefined;
    c.server.respondToStop(cancelled => {
      // A refused/malformed synthetic gateway does not actually cancel the running start.
      if (outcome !== 'cancelled' && original) Object.assign(cancelled, original);
      entered.resolve(); return response.promise;
    });
    const alerts = () => [...c.dom.container.querySelectorAll('[role="alert"]')].map(node => node.textContent).join('\n');
    const expectedError = outcome === '409' ? refused : nativeCreationI18n.en['chat.nativeCreation.unknown'];
    try {
      await c.replace('original A text'); await c.submit(); await c.server.entered; await c.refresh();
      original = { ...c.server.operation() };
      await c.clickStop(); await entered.promise;
      expect(c.stop()?.disabled).toBe(true);
      if (returned) { await c.navigate('b'); await c.replace('B untouched'); }
      const stopResponse = outcome === '409'
        ? Response.json({ name: 'APIError', data: { message: refused, isRetryable: false } }, { status: 409 })
        : outcome === 'malformed' ? Response.json({ nativeCreation: { phase: 'cancelled' } })
        : Response.json({ nativeCreation: c.server.operation() });
      await act(async () => { response.resolve(stopResponse); await sleep(30); });
      expect(c.text()).toBe(returned ? 'B untouched' : 'original A text');
      if (returned) {
        expect(c.stop()).toBeNull(); expect(alerts()).not.toContain(expectedError);
        expect(alerts()).not.toContain(nativeCreationI18n.en['chat.nativeCreation.stopped']);
        await c.navigate('a');
      }
      await c.refresh();
      expect(c.server.held[0].released).toBe(false);
      expect(c.creates()).toHaveLength(1); expect(c.server.state.abandons).toHaveLength(1); expect(c.prompts()).toHaveLength(0);
      expect(c.text()).toBe('original A text');
      console.log(JSON.stringify({ outcome, returned, starting: c.starting(), stopDisabled: c.stop()?.disabled,
        held: !c.server.held[0].released, creates: c.creates().length, abandons: c.server.state.abandons.length, prompts: c.prompts().length }));
      if (outcome === 'cancelled') {
        expect(c.starting()).toBe(false); expect(c.stop()).toBeNull();
        expect(abandonedNativeCreations.has(original.operationId)).toBe(true);
      } else {
        expect(c.starting()).toBe(true); expect(c.server.operation().phase).toBe('starting');
        expect(abandonedNativeCreations.has(original.operationId)).toBe(false);
        expect(c.stop()).not.toBeNull(); expect(c.stop()?.disabled).toBe(false);
        expect(alerts()).toContain(expectedError);
        if (returned) {
          await c.navigate('b'); expect(c.text()).toBe('B untouched'); expect(alerts()).not.toContain(expectedError);
          await c.navigate('a'); await c.refresh(); expect(c.stop()?.disabled).toBe(false); expect(alerts()).toContain(expectedError);
        }
        c.server.respondToStop(cancelled => Response.json({ nativeCreation: cancelled }));
        await c.clickStop();
        expect(c.starting()).toBe(false); expect(c.stop()).toBeNull(); expect(c.text()).toBe('original A text');
        expect(c.server.state.abandons).toHaveLength(2); expect(c.creates()).toHaveLength(1); expect(c.prompts()).toHaveLength(0);
        expect(c.server.held[0].released).toBe(false);
      }
    } finally {
      response.resolve(Response.json({ nativeCreation: c.server.operation() }));
      await c.dispose();
    }
  });
}
