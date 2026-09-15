import { afterEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { useInputStore } from './input-store';
import { materializeOpenDraftSession, useSessionUIStore } from './session-ui-store';
import { nativeCreationForDraft, prepareNativeDraft } from './native-draft-creation';
import { acceptedView, deferred, directory, draft, nativeDraftFixture, session } from './native-draft-fixture';

let fixture: ReturnType<typeof nativeDraftFixture>;
afterEach(() => fixture?.dispose());
const send = (onNativeAccepted?: () => void) => {
  const input = useInputStore.getState();
  return useSessionUIStore.getState().sendMessage(input.pendingInputText ?? 'Keep @notes.md',
    session.nativeCreation.model.providerID, session.nativeCreation.model.modelID, undefined,
    input.attachedFiles, undefined, input.pendingSyntheticParts ?? undefined, undefined, 'normal',
    { draftSnapshot: { ...useSessionUIStore.getState().newSessionDraft }, displayName: 'Test label', onNativeAccepted });
};
const retained = (input: ReturnType<typeof useInputStore.getState>) => {
  expect(useSessionUIStore.getState().newSessionDraft).toEqual(draft);
  expect(useSessionUIStore.getState().currentSessionId).toBeNull();
  expect(useInputStore.getState()).toBe(input);
  const owner = nativeCreationForDraft(useSessionUIStore.getState().nativeDraftCreations, draft, fixture.runtimeA);
  expect(owner?.status).toBe('created');
  if (owner?.status === 'created') expect(owner.session.id).toBe(session.id);
};

test('actual store Send waits for first accepted loader history, then sends once with exact view/context/attribution', async () => {
  fixture = nativeDraftFixture(); await prepareNativeDraft();
  const history = deferred<Response>(); fixture.handlers.history = async () => history.promise;
  const input = useInputStore.getState(); let accepted = 0;
  const pending = send(() => { accepted++; });
  await Bun.sleep(0);
  expect(fixture.loader.getSnapshot({ directory, sessionID: session.id }).status).toBe('loading');
  expect(fixture.prompts()).toHaveLength(0); expect(accepted).toBe(0); retained(input);
  history.resolve(Response.json([], { headers: { 'x-smarty-ordinary-view': acceptedView } }));
  await pending;
  expect(fixture.prompts()).toHaveLength(1); expect(accepted).toBe(1); expect(fixture.creates()).toHaveLength(1);
  const request = fixture.prompts()[0];
  expect(request.headers.get('x-smarty-ordinary-view')).toBe(acceptedView);
  const body = await request.json();
  expect(body.model).toEqual(session.nativeCreation.model);
  expect(body.parts).toContainEqual({ type: 'text', text: 'Keep @notes.md', metadata: { smartyCodeDisplayName: 'Test label' } });
  expect(body.parts).toContainEqual({ type: 'text', text: 'draft-only context', synthetic: true });
  expect(body.parts).toContainEqual({ type: 'text', text: 'input context', synthetic: true });
  expect(body.parts.some((part: { type: string }) => part.type === 'file')).toBe(true);
  expect(useSessionUIStore.getState().currentSessionId).toBe(session.id);
});

for (const failure of ['history-error', 'missing-view', 'input-refusal'] as const) {
  test(`${failure} retains entire prepared draft/owner; a later explicit Send reuses it without create replay`, async () => {
    fixture = nativeDraftFixture(); await prepareNativeDraft();
    const input = useInputStore.getState(); let accepted = 0;
    if (failure === 'history-error') fixture.handlers.history = async () => Response.json({ message: 'read refused' }, { status: 409 });
    if (failure === 'missing-view') fixture.handlers.history = async () => Response.json([]);
    if (failure === 'input-refusal') fixture.handlers.prompt = async () => Response.json({ message: 'Finish original Pi dialogs and /code-ready' }, { status: 409 });
    await expect(send(() => { accepted++; })).rejects.toThrow();
    expect(accepted).toBe(0); retained(input); expect(fixture.creates()).toHaveLength(1);
    const count = failure === 'input-refusal' ? 1 : 0;
    expect(fixture.prompts()).toHaveLength(count);
    if (failure === 'history-error') expect(fixture.loader.getSnapshot({ directory, sessionID: session.id }).status).toBe('error');
    fixture.handlers.history = async () => Response.json([], { headers: { 'x-smarty-ordinary-view': acceptedView } });
    fixture.handlers.prompt = async () => new Response(null, { status: 204 });
    await Bun.sleep(0); expect(fixture.prompts()).toHaveLength(count);
    await send(() => { accepted++; });
    expect(fixture.prompts()).toHaveLength(count + 1); expect(accepted).toBe(1); expect(fixture.creates()).toHaveLength(1);
    const body = await fixture.prompts().at(-1)!.json();
    expect(body.parts.some((part: { text?: string }) => part.text === 'draft-only context')).toBe(true);
    expect(body.parts.some((part: { text?: string }) => part.text === 'input context')).toBe(true);
    expect(body.parts.some((part: { type: string }) => part.type === 'file')).toBe(true);
  });
}

test('materialization itself awaits accepted history and never selects or consumes the prepared draft', async () => {
  fixture = nativeDraftFixture(); await prepareNativeDraft();
  const history = deferred<Response>(); fixture.handlers.history = async () => history.promise;
  const pending = materializeOpenDraftSession(session.nativeCreation.model);
  await Bun.sleep(0); expect(useSessionUIStore.getState().newSessionDraft).toEqual(draft);
  history.resolve(Response.json([], { headers: { 'x-smarty-ordinary-view': acceptedView } }));
  expect((await pending)?.sessionId).toBe(session.id);
  expect(useSessionUIStore.getState().currentSessionId).toBeNull();
  expect(useSessionUIStore.getState().newSessionDraft).toEqual(draft);
  expect(fixture.prompts()).toHaveLength(0);
});

test('target changes during history and SDK attribution preparation refuse before prompt dispatch', async () => {
  fixture = nativeDraftFixture(); await prepareNativeDraft();
  const history = deferred<Response>(); fixture.handlers.history = async () => history.promise;
  const pending = send(); await Bun.sleep(0);
  fixture.target('b', '/native-project-b');
  history.resolve(Response.json([], { headers: { 'x-smarty-ordinary-view': acceptedView } }));
  await expect(pending).rejects.toThrow(); expect(fixture.prompts()).toHaveLength(0);
  fixture.target('a', directory);
  fixture.handlers.health = async () => { fixture.target('b', '/native-project-b'); return Response.json({ healthy: true, capabilities: { displayAttribution: 1 } }); };
  await expect(send()).rejects.toThrow();
  expect(fixture.prompts()).toHaveLength(0); expect(fixture.creates()).toHaveLength(1);
});

test('runtime change while history loads refuses without input mutation; restoring A permits only a later explicit Send', async () => {
  fixture = nativeDraftFixture(); await prepareNativeDraft();
  const input = useInputStore.getState();
  const history = deferred<Response>(); fixture.handlers.history = async () => history.promise;
  const pending = send(); await Bun.sleep(0);
  fixture.switchRuntime('send-runtime-b');
  history.resolve(Response.json([], { headers: { 'x-smarty-ordinary-view': acceptedView } }));
  await expect(pending).rejects.toThrow(); expect(fixture.prompts()).toHaveLength(0);
  expect(useInputStore.getState()).toBe(input);
  fixture.switchRuntime(fixture.runtimeA); retained(input);
  fixture.handlers.history = async () => Response.json([], { headers: { 'x-smarty-ordinary-view': acceptedView } });
  expect(fixture.prompts()).toHaveLength(0);
  await send(); expect(fixture.prompts()).toHaveLength(1); expect(fixture.creates()).toHaveLength(1);
});

test('revoked accepted history during knowledge preparation refuses before the SDK can capture a missing view', async () => {
  fixture = nativeDraftFixture(); await prepareNativeDraft();
  const input = useInputStore.getState();
  fixture.handlers.knowledge = async () => {
    fixture.loader.invalidateOrdinaryView({ directory, sessionID: session.id }, true);
    return new Response(null, { status: 404 });
  };
  await expect(send()).rejects.toThrow();
  expect(fixture.prompts()).toHaveLength(0); retained(input); expect(fixture.creates()).toHaveLength(1);
});

test('another explicit Send cannot dispatch while the same native draft prompt is pending', async () => {
  fixture = nativeDraftFixture(); await prepareNativeDraft();
  const response = deferred<Response>(); fixture.handlers.prompt = async () => response.promise;
  const first = send(); await Bun.sleep(0);
  expect(fixture.prompts()).toHaveLength(1);
  await expect(send()).rejects.toThrow(); expect(fixture.prompts()).toHaveLength(1);
  response.resolve(new Response(null, { status: 204 })); await first;
});

test('composer keeps native input/context untouched until the store acceptance callback', () => {
  const source = readFileSync(new URL('../components/chat/ChatInput.tsx', import.meta.url), 'utf8');
  expect(source).toContain('retainNativeDraft ? useInputStore.getState().pendingSyntheticParts : consumePendingSyntheticParts()');
  expect(source).toContain('retainNativeDraft ? useInlineCommentDraftStore.getState().getDrafts(consumedDraftTarget) : consumeDrafts(consumedDraftTarget)');
  expect(source).toContain('onNativeAccepted: clearSubmittedInput');
  expect(source).toContain('else clearSubmittedInput();');
  // Supporting source wiring only; the real SDK/loader/store boundary is exercised above, not a browser proof.
});
