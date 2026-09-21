import { afterEach, expect, test } from 'bun:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { NativeCreationError } from '@/lib/opencode/nativeCreation';
import { useInputStore } from './input-store';
import { useSessionUIStore } from './session-ui-store';
import { prepareNativeDraft, preparedNativeDraft } from './native-draft-creation';
import { assertNativeDraftReady, beginNativeDraftSend, prepareNativeDraftSend } from './native-draft-send';
import { acceptedView, deferred, directory, nativeDraftFixture } from './native-draft-fixture';

let fixture: ReturnType<typeof nativeDraftFixture>;
afterEach(() => fixture?.dispose());
const member = { id: 'a', path: directory };
const admit = (present: boolean) => useProjectsStore.setState({
  managedCatalogAdmitted: true, managedCatalogStatus: 'ready',
  managedProjects: present ? [member] : [],
  managedRows: present ? [{ id: 'gateway-a', worktree: directory }] : [],
});

for (const status of ['retired', 'unavailable'] as const) {
  test(`cached and captured native sends refuse ${status} membership without reads or losing the draft`, async () => {
    fixture = nativeDraftFixture(); admit(true);
    await prepareNativeDraft();
    const before = useSessionUIStore.getState(), input = useInputStore.getState();
    const created = await preparedNativeDraft(before.newSessionDraft);
    if (!created) throw new Error('Expected native creation');
    const target = await prepareNativeDraftSend(before.newSessionDraft, created);
    if (status === 'retired') admit(false);
    else useProjectsStore.setState({ managedCatalogStatus: 'unavailable' });
    const requests = fixture.requests.length;
    await expect(preparedNativeDraft(before.newSessionDraft)).rejects.toBeInstanceOf(NativeCreationError);
    await expect(prepareNativeDraft()).rejects.toBeInstanceOf(NativeCreationError);
    await expect(prepareNativeDraftSend(before.newSessionDraft, created)).rejects.toBeInstanceOf(NativeCreationError);
    expect(() => assertNativeDraftReady(target)).toThrow(NativeCreationError);
    expect(() => beginNativeDraftSend(target)).toThrow(NativeCreationError);
    expect(fixture.requests).toHaveLength(requests);
    expect(useSessionUIStore.getState().newSessionDraft).toBe(before.newSessionDraft);
    expect(useSessionUIStore.getState().nativeDraftCreations).toBe(before.nativeDraftCreations);
    expect(useInputStore.getState()).toBe(input);
    admit(true);
    expect(await preparedNativeDraft(before.newSessionDraft)).toBe(created);
    const finish = beginNativeDraftSend(target); finish();
    expect(fixture.creates()).toHaveLength(1);
    expect(fixture.prompts()).toHaveLength(0);
  });
}

test('retirement during a capability read prevents native creation', async () => {
  fixture = nativeDraftFixture(); admit(true);
  fixture.handlers.health = async () => {
    admit(false);
    return Response.json({ healthy: true, capabilities: { ordinaryCreateOnly: 1 } });
  };
  const before = useSessionUIStore.getState().newSessionDraft;
  await expect(prepareNativeDraft()).rejects.toBeInstanceOf(NativeCreationError);
  expect(fixture.creates()).toHaveLength(0);
  expect(fixture.prompts()).toHaveLength(0);
  expect(useSessionUIStore.getState().newSessionDraft).toBe(before);
});

test('retirement while ordinary history is held prevents captured send readiness', async () => {
  fixture = nativeDraftFixture(); admit(true);
  await prepareNativeDraft();
  const before = useSessionUIStore.getState();
  const held = deferred<Response>();
  fixture.handlers.history = () => held.promise;
  const created = await preparedNativeDraft(before.newSessionDraft);
  if (!created) throw new Error('Expected native creation');
  const pending = prepareNativeDraftSend(before.newSessionDraft, created);
  await sleep(0); admit(false);
  held.resolve(Response.json([], { headers: { 'x-smarty-ordinary-view': acceptedView } }));
  await expect(pending).rejects.toBeInstanceOf(NativeCreationError);
  expect(useSessionUIStore.getState().newSessionDraft).toBe(before.newSessionDraft);
  expect(useSessionUIStore.getState().nativeDraftCreations).toBe(before.nativeDraftCreations);
  expect(fixture.creates()).toHaveLength(1);
  expect(fixture.prompts()).toHaveLength(0);
});
