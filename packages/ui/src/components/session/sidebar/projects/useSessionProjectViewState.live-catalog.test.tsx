import { describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { DesktopSettings } from '@/lib/desktop';
import { installHookTestDom } from '../test-utils/testDom';

const settingsWrites: Array<Partial<DesktopSettings>> = [];

mock.module('@/lib/persistence', () => ({
  sanitizeProjects: (value: unknown) => Array.isArray(value) ? value as DesktopSettings['projects'] : undefined,
  sanitizeWebSettings: (value: unknown) => value && typeof value === 'object' ? value as DesktopSettings : null,
  getSettingsSaveState: () => 'idle',
  updateDesktopSettings: (changes: Partial<DesktopSettings>) => {
    settingsWrites.push(changes);
    return Promise.resolve();
  },
}));

// The persistence mock must be registered before these modules capture it.
const { useProjectsStore } = await import('@/stores/useProjectsStore');
const { useSessionProjectViewState } = await import('./useSessionProjectViewState');

type HookValue = ReturnType<typeof useSessionProjectViewState>;

describe('useSessionProjectViewState live catalog', () => {
  test('persists collapse flags only for presentation projects', async () => {
    settingsWrites.length = 0;
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const settingsProject = { id: 'settings-project', path: '/settings-project' };
    const liveOnlyProject = { id: 'live-only-project', path: '/live-only-project' };
    const storeSnapshot = useProjectsStore.getState();
    useProjectsStore.setState({
      projects: [settingsProject, liveOnlyProject],
      presentationProjects: [settingsProject],
      runtimeProjectMembershipActive: true,
      activeProjectId: settingsProject.id,
      manualProjectOrder: [],
    });

    let state: HookValue['state'] | undefined;
    let actions: HookValue['actions'] | undefined;
    const Harness = () => {
      const value = useSessionProjectViewState({ isVSCode: false, projects: [{ id: settingsProject.id }] });
      state = value.state;
      actions = value.actions;
      return null;
    };

    try {
      await act(async () => root.render(React.createElement(Harness)));
      if (!actions) throw new Error('hook did not mount');

      await act(async () => actions!.toggleProject(settingsProject.id));
      expect(state?.collapsedProjects).toEqual(new Set([settingsProject.id]));

      // flushCollapsedProjectsPersist debounces the settings write by 700ms.
      await new Promise((resolve) => setTimeout(resolve, 1000));

      expect(settingsWrites).toHaveLength(1);
      const written = settingsWrites[0]?.projects ?? [];
      // The live runtime catalog entry must never be written back to settings.
      expect(written.map((project) => project.id)).toEqual([settingsProject.id]);
      expect(written[0]?.sidebarCollapsed).toBe(true);
    } finally {
      await act(async () => root.unmount());
      useProjectsStore.setState(storeSnapshot, true);
      dom.restore();
    }
  });
});
