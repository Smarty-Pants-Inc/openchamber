import { expect, test } from 'bun:test';
import React, { act } from 'react';
import { setTimeout as sleep } from 'node:timers/promises';
import { mountedNativeComposer } from '@/components/chat/composer/submit/__tests__/nativeComposer.fixture';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useAuthSessionStore } from '@/lib/runtime-auth-expiry';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useI18nStore } from '@/lib/i18n';
const { AuthExpiredBanner } = await import('./AuthExpiredBanner');

const unavailable = 'Live projects and sessions could not be refreshed. Shown items may be out of date. Projects and Pi sessions are managed in Herdr.';
const empty = 'No live projects are available. Projects and Pi sessions are managed in Herdr.';

test('actual shared notice distinguishes unavailable/empty, preserves work and gives auth expiry priority', async () => {
  const authBefore = useAuthSessionStore.getState();
  const c = await mountedNativeComposer(false, undefined,
    <section data-testid="actual-shared-notice"><AuthExpiredBanner /></section>);
  try {
    expect(useI18nStore.getState().locale).toBe('en'); // Existing fixture default, not an English fallback.
    const host = c.dom.container.querySelector('[data-testid="actual-shared-notice"]');
    if (!host) throw new Error('Actual notice mount missing');
    const project = useProjectsStore.getState().projects[0];
    if (!project) throw new Error('Fixture project missing');
    await act(async () => { useAuthSessionStore.setState({ state: 'ok' }); });
    await c.replace('Keep this unsent draft');
    const draft = useSessionUIStore.getState().newSessionDraft;
    const bookmarks = useProjectsStore.getState().projects;

    for (const rows of [[project], []]) {
      await act(async () => {
        useProjectsStore.setState({ managedCatalogAdmitted: true,
          managedCatalogStatus: 'unavailable', managedProjects: rows });
        await sleep(0);
      });
      expect(host.querySelector('[role="status"]')?.textContent).toBe(unavailable);
      expect(host.textContent).not.toContain(empty);
      expect(host.querySelector('button')).toBeNull(); // No new retry, settings or mutation action.
    }
    await act(async () => {
      useProjectsStore.setState({ managedCatalogStatus: 'ready', managedProjects: [] });
    });
    expect(host.querySelector('[role="status"]')?.textContent).toBe(empty);
    expect(host.textContent).not.toContain(unavailable);
    await act(async () => {
      useProjectsStore.setState({ managedProjects: [project] });
    });
    expect(host.textContent).toBe('');

    await act(async () => {
      useProjectsStore.setState({ managedCatalogStatus: 'unavailable' });
      useAuthSessionStore.setState({ state: 'expired' });
    });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Your session expired');
    expect(host.querySelector('button')?.textContent).toBe('Log in');
    expect(host.querySelector('[role="status"]')).toBeNull();
    await act(async () => { useAuthSessionStore.setState({ state: 'reauthenticating' }); });
    expect(host.textContent).toBe('');
    await act(async () => {
      useAuthSessionStore.setState({ state: 'ok' });
      useProjectsStore.getState().resetManagedCatalog();
    });
    expect(host.textContent).toBe('');
    await act(async () => {
      useProjectsStore.setState({ managedCatalogStatus: 'stock' });
    });
    expect(host.textContent).toBe('');
    expect(useProjectsStore.getState().projects).toBe(bookmarks);
    expect(useSessionUIStore.getState().newSessionDraft).toEqual(draft);
    expect(c.text()).toBe('Keep this unsent draft');
    expect(c.prompts()).toHaveLength(0);
  } finally {
    try { await c.dispose(); }
    finally { useAuthSessionStore.setState(authBefore, true); }
  }
});
