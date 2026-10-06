import { afterEach, expect, test } from 'bun:test';
import { STOP_START_GRACE_MS } from '@/sync/native-draft-control';
import { opencodeClient } from '@/lib/opencode/client';
import { directory } from '@/sync/native-draft-fixture';
import { nativeCreationForDraft } from '@/sync/native-draft-creation';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { mountedStart523 } from './startRelease523.fixture';

let mounted: Awaited<ReturnType<typeof mountedStart523>> | undefined;
afterEach(async () => { await mounted?.dispose(); mounted = undefined; });

for (const threshold of ['expiry', 'grace'] as const) for (const returned of [false, true]) {
  test(`held actual create offers own Stop after ${threshold}, ${returned ? 'leave B and return A' : 'stay A'}`, async () => {
    const c = mounted = await mountedStart523('create');
    const now = Date.now; let clock = now(); Date.now = () => clock;
    try {
      await c.replace('held create text'); await c.submit(); await c.server.entered;
      const operation = c.server.operation();
      expect(await opencodeClient.listNativeCreations(directory)).toEqual([operation]);
      await c.refresh();
      expect(c.stop()).toBeNull(); // Within expiry and grace, do not offer premature Stop.
      clock = threshold === 'expiry' ? operation.expiresAt + 1 : clock + STOP_START_GRACE_MS + 1;
      if (returned) { await c.navigate('b'); await c.navigate('a'); }
      await c.refresh();
      const ui = useSessionUIStore.getState();
      const record = nativeCreationForDraft(ui.nativeDraftCreations, ui.newSessionDraft, c.runtimeA);
      console.log(`523 create ${threshold} return=${returned} record=${record?.status} starting=${c.starting()} stop=${!!c.stop()} text=${JSON.stringify(c.text())} creates=${c.creates().length} prompts=${c.prompts().length} lists=${c.server.state.listReads}`);
      expect(c.text()).toBe('held create text');
      expect(c.creates()).toHaveLength(1); expect(c.prompts()).toHaveLength(0);
      expect(c.stop()).not.toBeNull(); // RED: creating has no own op, despite fresh exact request-ID listing.
      expect(c.stop()?.disabled).toBe(false);
      await c.clickStop();
      expect(c.starting()).toBe(false);
      expect(c.text()).toBe('held create text');
      await c.submit();
      expect(c.creates()).toHaveLength(2); expect(c.prompts()).toHaveLength(1);
    } finally { Date.now = now; }
  });
}
