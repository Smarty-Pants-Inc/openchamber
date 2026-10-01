import React, { act } from 'react';
import { expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { createRoot } from 'react-dom/client';
import { nativeCreationI18n } from '@/lib/i18n/messages/native-creation.i18n';
import { opencodeClient } from '@/lib/opencode/client';
import { NativeCreationError, type NativeCreationState } from '@/lib/opencode/nativeCreation';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { claimChatDraftOwnership, createChatDraftIdentity, readChatDraft, writeChatDraft } from '@/lib/chatDraftPersistence';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { nativeCreationForDraft, publishNativeCreation, type NativeDraftCreation } from '@/sync/native-draft-creation';
import { startNativeDraft } from '@/sync/native-draft-start';
import { pillSendDisabledReason } from './pillSendDisabledReason';

// Existing notice-test precedent: only UI translation/search hooks are replaced, never business modules.
const i18n = await import('@/lib/i18n');
mock.module('@/lib/i18n', () => ({ ...i18n, useI18n: () => ({ t: (key: keyof typeof nativeCreationI18n.en, params: Record<string, string> = {}) =>
  (nativeCreationI18n.en[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => params[name] ?? name) }) }));
mock.module('@/lib/search/fuzzySearch', () => ({ matchesFuzzyQuery: () => false }));
const { useNativeCreation } = await import('../state/useNativeCreation');
const { NativeCreationNotice } = await import('./NativeCreationNotice');
type Native = ReturnType<typeof useNativeCreation>;
const words = nativeCreationI18n.en;
const gone = words['chat.nativeCreation.notAdmitted'];
const check = words['chat.nativeCreation.check'];
const escape = words['chat.nativeCreation.startAgain'];
const error = new NativeCreationError('unavailable', undefined, 'Own failure: no request was accepted');
const target = () => ({ runtimeKey: getRuntimeKey(), draftId: 1118, directory: '/withdrawn', projectId: 'owned' });
const failed = (submitted = false): NativeDraftCreation => ({ ...target(), status: 'failed', submitted, error });
const operation: NativeCreationState = { operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', directory: '/withdrawn',
  generation: null, revision: 1, phase: 'awaiting-trust', expiresAt: Date.now() - 1_000, canInitialReady: false };
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });

async function mounted(run: (host: HTMLElement, read: () => Native, render: (fixture?: Native) => Promise<void>) => Promise<void>) {
  const win = new Window({ url: 'http://localhost' });
  const values = { window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage, sessionStorage: win.sessionStorage, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true });
  const original = useSessionUIStore.getState();
  useSessionUIStore.setState({ newSessionDraft: { ...original.newSessionDraft, open: true, draftId: 1118,
    target: 'project', directoryOverride: '/withdrawn', selectedProjectId: 'owned' }, nativeDraftCreations: new Map() });
  // createElement through lib.dom's document avoids asserting happy-dom's element type.
  const host = document.createElement('div'), root = createRoot(host);
  let latest: Native | undefined;
  const Probe = ({ fixture }: { fixture?: Native }) => {
    const draft = useSessionUIStore(state => state.newSessionDraft);
    latest = useNativeCreation(draft, null, undefined, getRuntimeKey());
    return <NativeCreationNotice native={fixture ?? latest} draftOpen />;
  };
  const render = async (fixture?: Native) => { await act(async () => root.render(<Probe fixture={fixture} />)); };
  try {
    await render(); await settle();
    await run(host, () => { if (!latest) throw new Error('Hook not mounted'); return latest; }, render);
  } finally {
    await act(async () => root.unmount());
    useSessionUIStore.setState({ newSessionDraft: original.newSessionDraft, nativeDraftCreations: original.nativeDraftCreations });
    useProjectsStore.getState().resetManagedCatalog();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
    await win.happyDOM.close();
  }
}

test('failed unsubmitted creation yields only after the ready-catalog second 403 check', async () => {
  const original = opencodeClient.nativeCreationSupport;
  let checks = 0;
  // Supported client-method seam from useNativeCreation.catalog.test.tsx: real hook/classification/store below it.
  opencodeClient.nativeCreationSupport = async directory => {
    expect(directory).toBe('/withdrawn'); checks++;
    throw Object.assign(new Error('Project is not configured'), { status: 403 });
  };
  useProjectsStore.getState().resetManagedCatalog();
  useProjectsStore.setState({ managedCatalogStatus: 'stock', managedCatalogStockConfirmed: true });
  try {
    await mounted(async (host, read) => {
      await act(async () => publishNativeCreation(target(), failed()));
      expect([checks, read().mode]).toEqual([1, 'unavailable']);
      expect(host.textContent).toContain(error.detail);
      expect(host.textContent).toContain(check);
      const draft = useSessionUIStore.getState().newSessionDraft;
      const identity = createChatDraftIdentity(getRuntimeKey(), '/withdrawn', null, draft.draftId);
      claimChatDraftOwnership(identity); writeChatDraft(identity, 'Held draft text', []);
      expect(readChatDraft(identity).text).toBe('Held draft text');
      const source = nativeCreationForDraft(useSessionUIStore.getState().nativeDraftCreations, draft, getRuntimeKey());
      await act(async () => useProjectsStore.getState().applyManagedCatalog([{ id: 'other', worktree: '/other' }]));
      await settle();
      expect([checks, read().mode]).toEqual([2, 'notAdmitted']);
      expect(nativeCreationForDraft(useSessionUIStore.getState().nativeDraftCreations, draft, getRuntimeKey())).toBe(source);
      expect(useSessionUIStore.getState().newSessionDraft).toEqual(draft);
      expect(readChatDraft(identity).text).toBe('Held draft text');
      expect(pillSendDisabledReason({ ordinaryUnavailable: false, newSessionDraftOpen: true, nativeMode: read().mode }, () => gone)).toBe(gone);
      // RED must be this mounted stale explanation, not an import/setup failure.
      expect(host.textContent).toContain(gone);
      expect(host.textContent).not.toContain(error.detail);
      expect(host.textContent).not.toContain(check);
    });
  } finally { opencodeClient.nativeCreationSupport = original; }
});

test('receiver-controlled fixtures keep submitted, pending, submission and own Stop controls', async () => {
  const original = opencodeClient.nativeCreationSupport;
  opencodeClient.nativeCreationSupport = async () => { throw Object.assign(new Error('not admitted'), { status: 403 }); };
  useProjectsStore.getState().applyManagedCatalog([{ id: 'other', worktree: '/other' }]);
  try {
    await mounted(async (host, read, render) => {
      // Props fixtures exercise only notice precedence; they do not prove the two-check hook sequence above.
      const base = { ...read(), mode: 'notAdmitted' as const, refusal: null, canAbandon: true };
      await render({ ...base, creation: failed(true) });
      expect(host.textContent).toContain(error.detail);
      expect(host.textContent).toContain(check);
      expect(host.textContent).toContain(escape);
      expect(host.textContent).not.toContain(gone);
      // An absent admission flag is unknown, not evidence that no request was submitted.
      const incomplete = failed(); Reflect.deleteProperty(incomplete, 'submitted');
      await render({ ...base, creation: incomplete });
      expect(host.textContent).toContain(error.detail);
      expect(host.textContent).toContain(check);
      expect(host.textContent).not.toContain(gone);
      for (const creation of [
        { ...target(), status: 'pending' as const, operation, unreadable: true },
        { ...target(), status: 'pending' as const, operation, error },
      ]) {
        await render({ ...base, creation });
        expect(host.textContent).toContain(check);
        expect(host.querySelector('[data-operation-id]')?.getAttribute('data-operation-id')).toBe(operation.operationId);
        expect(host.textContent).not.toContain(gone);
      }
      for (const status of ['creating', 'checking'] as const) {
        await render({ ...base, creation: { ...target(), status } });
        expect(host.textContent).toContain(words['chat.nativeCreation.starting']);
        expect(host.textContent).not.toContain(gone);
      }
      await render({ ...base, mode: 'ordinary', creation: failed() });
      expect(host.textContent).toContain(error.detail);
      expect(host.textContent).toContain(check);
      expect(host.textContent).not.toContain(gone);
    });
  } finally { opencodeClient.nativeCreationSupport = original; }
});

test('a real global start in flight cannot be replaced by a withdrawn explanation', async () => {
  const original = { support: opencodeClient.nativeCreationSupport, supports: opencodeClient.supportsNativeCreation };
  opencodeClient.nativeCreationSupport = async () => { throw Object.assign(new Error('not admitted'), { status: 403 }); };
  let release = () => {};
  const held = new Promise<boolean>(resolve => { release = () => resolve(false); });
  opencodeClient.supportsNativeCreation = async () => held;
  useProjectsStore.getState().resetManagedCatalog();
  useProjectsStore.setState({ managedCatalogStatus: 'stock', managedCatalogStockConfirmed: true });
  try {
    await mounted(async (host, read, render) => {
      let starting = Promise.resolve();
      await act(async () => { starting = startNativeDraft([]); });
      try {
        await settle();
        await render({ ...read(), mode: 'notAdmitted', creation: null });
        expect(host.textContent).toContain(words['chat.nativeCreation.starting']);
        expect(host.textContent).not.toContain(gone);
        await render({ ...read(), mode: 'notAdmitted', creation: failed() });
        expect(host.textContent).toContain(error.detail);
        expect(host.textContent).toContain(check);
        expect(host.textContent).not.toContain(gone);
      } finally { release(); await act(async () => { await starting; }); }
    });
  } finally { Object.assign(opencodeClient, { nativeCreationSupport: original.support, supportsNativeCreation: original.supports }); }
});
