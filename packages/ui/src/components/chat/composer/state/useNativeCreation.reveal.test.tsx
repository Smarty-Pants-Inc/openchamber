import '@/sync/native-test-network';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, spyOn, test } from 'bun:test';
import { nativeComposerDom } from '../submit/__tests__/nativeComposer-dom';
import { I18nProvider } from '@/lib/i18n';
import { useHumanAuth } from '@/lib/human-auth';
import { useAuthSessionStore } from '@/lib/runtime-auth-expiry';
import { isRuntimeRequestScopeCurrent } from '@/lib/runtime-switch';
import { isPersonalSidebarAdmissionCurrent, setPersonalSidebarView, usePersonalSidebarView } from '@/lib/sidebar-view';
import { useSessionReveal } from '@/components/session/sidebar/list/sessionReveal';
import { acceptedView, deferred, directory, nativeDraftFixture, session } from '@/sync/native-draft-fixture';
import { useSessionUIStore, type SessionRevealTicket } from '@/sync/session-ui-store';
import { prepareNativeDraftSend } from '@/sync/native-draft-send';
import { useNativeCreation } from './useNativeCreation';

// Synthetic native and preference replies exercise the original producer, not real provider/auth admission.
// The process-lifetime deny-fetch guard remains installed before and after each fixture.
async function mounted(run: (context: {
  fixture: ReturnType<typeof nativeDraftFixture>;
  hook: () => ReturnType<typeof useNativeCreation>;
  tickets: SessionRevealTicket[];
  patches: Array<Parameters<typeof setPersonalSidebarView>[0]>;
  admission: ReturnType<typeof deferred<Response>>;
  successor: () => void;
  ready: () => boolean;
}) => Promise<void>) {
  const dom = nativeComposerDom();
  const human = useHumanAuth.getState(), auth = useAuthSessionStore.getState();
  useAuthSessionStore.getState().markAuthenticated();
  useHumanAuth.setState({ enabled: true });
  const fixture = nativeDraftFixture();
  const admission = deferred<Response>(), patches: Array<Parameters<typeof setPersonalSidebarView>[0]> = [];
  let person = 'A';
  const inner = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    if (url.origin !== 'http://synthetic.invalid') throw new Error('Unexpected synthetic target');
    if (url.pathname === '/api/config/sidebar-view') {
      if (request.method === 'PATCH') {
        patches.push(await request.json());
        return Response.json({});
      }
      return person === 'A' ? admission.promise : Response.json({ owner: { issuer: 'synthetic', subject: person },
        projects: { a: true, b: true }, groups: { 'a:root': true } });
    }
    return inner(input, init);
  };
  const tickets: SessionRevealTicket[] = [], begin = useSessionUIStore.getState().beginSessionReveal;
  const beginSpy = spyOn(useSessionUIStore.getState(), 'beginSessionReveal').mockImplementation(scope => {
    const ticket = begin(scope); tickets.push(ticket); return ticket;
  });
  let hook!: ReturnType<typeof useNativeCreation>, ready = false;
  function Probe() {
    hook = useNativeCreation(useSessionUIStore(state => state.newSessionDraft), null, directory, fixture.runtimeA);
    ready = usePersonalSidebarView().ready;
    useSessionReveal(id => id === session.id ? { projectId: 'a', groupKey: 'a:root' } : null);
    return null;
  }
  const root = createRoot(dom.container);
  try {
    await act(async () => root.render(<I18nProvider><Probe /></I18nProvider>));
    await run({ fixture, hook: () => hook, tickets, patches, admission, successor: () => { person = 'B'; }, ready: () => ready });
  } finally {
    admission.resolve(Response.json({ message: 'read refused' }, { status: 503 }));
    await act(async () => root.unmount());
    beginSpy.mockRestore(); globalThis.fetch = inner;
    useHumanAuth.setState(human, true); useAuthSessionStore.setState(auth, true);
    fixture.dispose(); await dom.restore();
  }
}
const settle = () => act(async () => { await new Promise(done => setTimeout(done, 0)); });
const readySession = { ...session, nativeCreation: { ...session.nativeCreation, inputReady: true } };

for (const heldAt of ['start', 'history'] as const) {
  test(`initiating native Send keeps its retired preference ticket across delayed ${heldAt}; fresh B Send reveals`, async () => {
    await mounted(async c => {
      const started = deferred<void>(), history = deferred<void>(), created = deferred<Response>(), loaded = deferred<Response>();
      c.fixture.handlers.create = async () => { started.resolve(); return heldAt === 'start' ? created.promise : Response.json(readySession); };
      c.fixture.handlers.history = async () => { history.resolve(); return loaded.promise; };
      let pending!: ReturnType<ReturnType<typeof useNativeCreation>['beforeSend']>;
      try {
        await act(async () => {
          pending = c.hook().beforeSend(); void pending.catch(() => undefined);
          expect(c.tickets).toHaveLength(1); // Synchronous with the press, before yielding.
        });
        const ticket = c.tickets[0];
        if (heldAt === 'start') await started.promise; else await history.promise;
        c.successor();
        await act(async () => c.admission.resolve(Response.json({ message: 'read refused' }, { status: 503 })));
        expect(isRuntimeRequestScopeCurrent(ticket.scope)).toBe(true); // No client auth renewal.
        expect(isPersonalSidebarAdmissionCurrent(ticket.preferenceAdmission)).toBe(false);
        await act(async () => setPersonalSidebarView({ projects: { b: false } }));
        expect(c.ready()).toBe(true);
        await act(async () => {
          created.resolve(Response.json(readySession));
          loaded.resolve(Response.json([], { headers: { 'x-smarty-ordinary-view': acceptedView } }));
        });
        const native = await pending;
        if (!native) throw new Error('Expected prepared native Send');
        expect(native.revealTicket).toBe(ticket); expect(c.tickets).toHaveLength(1);
        await act(async () => useSessionUIStore.getState().sendMessage('original native prompt',
          readySession.nativeCreation.model.providerID, readySession.nativeCreation.model.modelID,
          undefined, undefined, undefined, undefined, undefined, 'normal', { nativeIntent: native }));
        await settle();
        expect(c.fixture.prompts()).toHaveLength(1); expect(c.fixture.creates()).toHaveLength(1);
        expect(c.patches).toHaveLength(1); expect(c.patches[0].projects).toEqual({ b: false });
        expect(useSessionUIStore.getState().sessionRevealIntent).toBeNull();
        // A new explicit B Send can continue a fresh draft; no obsolete ticket renewal.
        c.fixture.handlers.create = async () => Response.json(readySession);
        c.fixture.handlers.history = async () => Response.json([], { headers: { 'x-smarty-ordinary-view': acceptedView } });
        await act(async () => useSessionUIStore.setState(state => ({ currentSessionId: null, newSessionDraft: { ...state.newSessionDraft,
          open: true, draftId: state.newSessionDraft.draftId + 1, target: 'project', selectedProjectId: 'a', directoryOverride: directory } })));
        let fresh: Awaited<ReturnType<ReturnType<typeof useNativeCreation>['beforeSend']>>;
        await act(async () => { fresh = await c.hook().beforeSend(); });
        if (!fresh?.revealTicket) throw new Error('Expected fresh B ticket');
        expect(fresh.revealTicket.preferenceAdmission).not.toBe(ticket.preferenceAdmission);
        await act(async () => useSessionUIStore.getState().sendMessage('fresh B prompt',
          readySession.nativeCreation.model.providerID, readySession.nativeCreation.model.modelID,
          undefined, undefined, undefined, undefined, undefined, 'normal', { nativeIntent: fresh }));
        await settle();
        expect(c.patches).toHaveLength(2); expect(c.patches[1].projects).toEqual({ a: false });
        expect(c.fixture.prompts()).toHaveLength(2); expect(c.fixture.creates()).toHaveLength(2);
      } finally {
        created.resolve(Response.json(readySession));
        loaded.resolve(Response.json([], { headers: { 'x-smarty-ordinary-view': acceptedView } }));
        await act(async () => { await pending.catch(() => undefined); });
      }
    });
  });
}

test('healthy same-person native Send forwards its exact initiating ticket; old prepare callers stay ticketless', async () => {
  await mounted(async c => {
    c.fixture.handlers.create = async () => Response.json(readySession);
    await act(async () => c.admission.resolve(Response.json({ owner: { issuer: 'synthetic', subject: 'A' }, projects: {}, groups: {} })));
    let native: Awaited<ReturnType<ReturnType<typeof useNativeCreation>['beforeSend']>>;
    await act(async () => { native = await c.hook().beforeSend(); });
    if (!native?.revealTicket) throw new Error('Expected native ticket');
    expect(native.revealTicket).toBe(c.tickets[0]); expect(c.tickets).toHaveLength(1);
    expect(isPersonalSidebarAdmissionCurrent(native.revealTicket.preferenceAdmission)).toBe(true);
    const legacy = await prepareNativeDraftSend(native.draft, native.session);
    expect(legacy.revealTicket).toBeUndefined(); expect(c.tickets).toHaveLength(1);
    await act(async () => useSessionUIStore.getState().sendMessage('healthy native prompt',
      readySession.nativeCreation.model.providerID, readySession.nativeCreation.model.modelID,
      undefined, undefined, undefined, undefined, undefined, 'normal', { nativeIntent: native }));
    await settle();
    expect(c.fixture.prompts()).toHaveLength(1); expect(c.patches).toHaveLength(1);
    expect(c.patches[0].projects).toEqual({ a: false }); expect(c.tickets).toHaveLength(1);
  });
});

for (const newerOpen of [false, true]) {
 test(`a failed native beforeSend consumes only its own ticket; newer open ${newerOpen}`, async () => {
  await mounted(async c => {
    const started = deferred<void>(), created = deferred<Response>();
    c.fixture.handlers.create = async () => { started.resolve(); return created.promise; };
    let pending!: ReturnType<ReturnType<typeof useNativeCreation>['beforeSend']>;
    await act(async () => { pending = c.hook().beforeSend(); });
    const outcome = pending.then(() => 'resolved', () => 'refused');
    try {
      expect(c.tickets).toHaveLength(1); await started.promise;
      let newer: SessionRevealTicket | undefined;
      await act(async () => { if (newerOpen) newer = useSessionUIStore.getState().beginSessionReveal(); });
      await act(async () => created.resolve(Response.json({ message: 'create refused' }, { status: 503 })));
      expect(await outcome).toBe('refused');
      expect(useSessionUIStore.getState().sessionRevealIntent?.revision).toBe(newer?.revision);
      expect(c.tickets).toHaveLength(newerOpen ? 2 : 1); expect(c.fixture.prompts()).toHaveLength(0);
    } finally {
      created.resolve(Response.json({ message: 'create refused' }, { status: 503 }));
      await act(async () => { await outcome; });
    }
  });
 });
}
