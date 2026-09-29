import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { mountedNativeComposer, shownActivity } from './composer/submit/__tests__/nativeComposer.fixture';
import { directory, session } from '@/sync/native-draft-fixture';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { recordStatusUnavailable } from '@/sync/status-unavailable';

// smarty-code#539: when the gateway cannot read the open session's project status, the composer says so instead of
// showing a stale working state; typing stays as it is.
let mounted: Awaited<ReturnType<typeof mountedNativeComposer>> | undefined;
afterEach(async () => { await mounted?.dispose(); mounted = undefined; shownActivity.phase = 'idle'; recordStatusUnavailable([]); });

async function openWorkingSession() {
  const c = mounted = await mountedNativeComposer(false);
  await act(async () => {
    useSessionUIStore.setState(state => ({ currentSessionId: session.id, currentSessionDirectory: directory,
      newSessionDraft: { ...state.newSessionDraft, open: false } }));
    // SAFETY: the fixture's session record is a complete Session; only its title changes.
    c.children.ensureChild(directory, { bootstrap: false }).setState({
      session: [{ ...session, title: 'org' } as never], session_status: { [session.id]: { type: 'busy' } },
    });
    shownActivity.phase = 'busy';
  });
  await act(async () => { c.rerender(); });
  return c;
}

const notice = (c: Awaited<ReturnType<typeof mountedNativeComposer>>) =>
  c.dom.container.querySelector('[data-testid="status-unavailable"]')?.textContent ?? null;

test("the open session's composer says 'Status unavailable' while its project's status is unknown", async () => {
  const c = await openWorkingSession();
  expect(notice(c)).toBeNull();
  await act(async () => { recordStatusUnavailable([directory]); });
  expect(notice(c)).toBe('Status unavailable');
  await c.replace('still typing');
  expect(c.text()).toBe('still typing');
  await act(async () => { recordStatusUnavailable([]); });
  expect(notice(c)).toBeNull();
});
