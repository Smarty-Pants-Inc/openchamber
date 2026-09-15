import { afterEach, expect, test } from 'bun:test';
import { opencodeClient } from '@/lib/opencode/client';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useInputStore } from './input-store';
import { useSessionUIStore } from './session-ui-store';
import { nativeCreationForDraft, prepareNativeDraft, recheckNativeDraft } from './native-draft-creation';
import { deferred, directory, draft, nativeDraftFixture, session } from './native-draft-fixture';

let fixture: ReturnType<typeof nativeDraftFixture>;
afterEach(() => fixture?.dispose());
const current = () => {
  const store = useSessionUIStore.getState();
  return nativeCreationForDraft(store.nativeDraftCreations, store.newSessionDraft, getRuntimeKey());
};
const unknown = () => Response.json({ name: 'APIError', data: {
  message: 'Inspect w1:p2 operation native-A /private/native-A/session.jsonl. Do not retry automatically.', isRetryable: false,
} }, { status: 503 });

for (const result of ['created', 'unknown', 'pending'] as const) {
  test(`project A/B/A retains ${result} A and late outcomes while B completes first`, async () => {
    fixture = nativeDraftFixture();
    const waitA = deferred<Response>();
    fixture.handlers.create = async request => new URL(request.url).searchParams.get('directory') === directory
      ? waitA.promise : Response.json({ ...session, id: '01234567-1234-4234-9234-012345678902', directory: '/native-project-b' });
    const a = prepareNativeDraft().catch(error => error);
    await Bun.sleep(0);
    if (result !== 'pending') { waitA.resolve(result === 'created' ? Response.json(session) : unknown()); await a; }
    const retainedA = current();
    fixture.target('b', '/native-project-b'); await prepareNativeDraft();
    expect(current()?.status).toBe('created');
    // Subscriber removal/reacquisition models state consumers leaving and returning; no component owns the record.
    const unmount = useSessionUIStore.subscribe(() => {}); unmount();
    fixture.target('a', directory);
    expect(current()).toBe(retainedA);
    await prepareNativeDraft(); expect(fixture.creates()).toHaveLength(2);
    if (result === 'pending') { waitA.resolve(unknown()); await a; }
    const restored = current();
    expect(restored?.status).toBe(result === 'created' ? 'created' : 'failed');
    if (restored?.status === 'created') expect(restored.session.id).toBe(session.id);
    if (restored?.status === 'failed') expect(restored.error.detail).toContain('operation native-A');
    await prepareNativeDraft(); expect(fixture.creates()).toHaveLength(2);
    expect(fixture.prompts()).toHaveLength(0);
  });

  test(`runtime A/B/A restores the same draft and ${result} result without another A request`, async () => {
    fixture = nativeDraftFixture();
    const waitA = deferred<Response>();
    let calls = 0;
    fixture.handlers.create = async () => ++calls === 1 ? waitA.promise : Response.json(session);
    const a = prepareNativeDraft().catch(error => error); await Bun.sleep(0);
    if (result !== 'pending') { waitA.resolve(result === 'created' ? Response.json(session) : unknown()); await a; }
    fixture.switchRuntime('runtime-b');
    useSessionUIStore.setState({ newSessionDraft: { ...draft } });
    await prepareNativeDraft();
    const b = current();
    if (result === 'pending') { waitA.resolve(Response.json(session)); await a; }
    expect(current()).toBe(b);
    fixture.switchRuntime(fixture.runtimeA);
    expect(useSessionUIStore.getState().newSessionDraft).toEqual(draft);
    const restored = current();
    expect(restored?.status).toBe(result === 'unknown' ? 'failed' : 'created');
    if (restored?.status === 'failed') expect(restored.error.detail).toContain('operation native-A');
    if (restored?.status === 'created') expect(restored.session.id).toBe(session.id);
    await prepareNativeDraft(); expect(fixture.creates()).toHaveLength(2);
    expect(fixture.prompts()).toHaveLength(0);
  });
}

test('pre-create capability failure allows one read-only check then a separate explicit Create', async () => {
  fixture = nativeDraftFixture();
  expect(await opencodeClient.supportsNativeCreation(directory)).toBe(true);
  const input = useInputStore.getState(), before = useSessionUIStore.getState().newSessionDraft;
  fixture.handlers.health = async () => new Response(null, { status: 503 });
  await expect(prepareNativeDraft()).rejects.toThrow();
  const failed = current();
  expect(failed?.status).toBe('failed');
  if (failed?.status === 'failed') expect(failed.submitted).toBe(false);
  await prepareNativeDraft(); expect(fixture.creates()).toHaveLength(0);
  fixture.handlers.health = async () => Response.json({ healthy: true, capabilities: { ordinaryCreateOnly: 1 } });
  const beforeCheck = fixture.requests.length;
  expect(await recheckNativeDraft()).toBe(true);
  expect(fixture.requests.slice(beforeCheck).map(request => [request.method, new URL(request.url).pathname]))
    .toEqual([['GET', '/api/global/health']]);
  expect(current()).toBeNull(); expect(fixture.creates()).toHaveLength(0);
  expect(useSessionUIStore.getState().newSessionDraft).toBe(before);
  expect(useInputStore.getState()).toBe(input);
  await prepareNativeDraft(); expect(fixture.creates()).toHaveLength(1);
  expect(fixture.prompts()).toHaveLength(0);
});

test('unknown post-create outcome cannot be cleared or retried through read-only recovery', async () => {
  fixture = nativeDraftFixture(); fixture.handlers.create = async () => unknown();
  await expect(prepareNativeDraft()).rejects.toThrow();
  const failed = current(), requests = fixture.requests.length;
  await expect(recheckNativeDraft()).rejects.toThrow();
  expect(fixture.requests).toHaveLength(requests); expect(current()).toBe(failed);
  await prepareNativeDraft(); expect(fixture.creates()).toHaveLength(1);
});
