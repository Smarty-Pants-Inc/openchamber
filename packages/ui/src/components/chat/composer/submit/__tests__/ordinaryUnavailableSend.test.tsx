import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { mountedNativeComposer, errors } from './nativeComposer.fixture';
import { session } from '@/sync/native-draft-fixture';
import { useSessionUIStore } from '@/sync/session-ui-store';

let mounted: Awaited<ReturnType<typeof mountedNativeComposer>> | undefined;
afterEach(async () => { await mounted?.dispose(); mounted = undefined; });

// smarty-code#126 3.13 (1b): when the selected native session turns "Unavailable", Send must say so, not do nothing.
test('Send on an unavailable native session shows why and keeps the input', async () => {
  const c = mounted = await mountedNativeComposer(true);
  await c.replace('First input'); await c.submit();
  expect(c.prompts()).toHaveLength(1);
  expect(useSessionUIStore.getState().currentSessionId).toBe(session.id);
  // The session record now reports its native model as unavailable (what the model control shows). It is held by
  // another directory's store (the parent's listing), not by the one the composer reads first.
  await act(async () => {
    c.children.ensureChild('/native-parent', { bootstrap: false }).setState((state) => ({
      session: [...state.session.filter((entry) => entry.id !== session.id), { ...session, nativeRuntime: 'ordinary' } as never],
    }));
  });
  errors.length = 0;
  await c.replace('Second input'); await c.submit();
  expect(c.prompts()).toHaveLength(1);
  expect(errors).toEqual(['This session is unavailable right now, so nothing was sent. Your message stays in the composer.']);
  expect(c.text()).toBe('Second input');
});
