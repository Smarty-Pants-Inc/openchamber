import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { ProjectEntry } from '@/lib/api/types'
import type { DesktopSettings } from '@/lib/desktop'

let settingsWrites: Array<{ projects?: ProjectEntry[]; activeProjectId?: string }> = []
let routeProjects: ProjectEntry[] | undefined

mock.module('@/lib/persistence', () => ({
  updateDesktopSettings: async (changes: { projects?: ProjectEntry[]; activeProjectId?: string }) => {
    settingsWrites.push(changes)
  },
}))

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: async () => {
    routeProjects = settingsWrites.at(-1)?.projects
    return new Response(JSON.stringify({ skipped: true }), {
      headers: { 'Content-Type': 'application/json' },
    })
  },
  bindRuntimeTransport: () => {
    throw new Error('bound transport fixture is not installed')
  },
}))

// The test mocks must be registered before this module captures its runtime dependencies.
const { useProjectsStore } = await import('./useProjectsStore')

describe('live catalog icon materialization', () => {
  beforeEach(() => {
    settingsWrites = []
    routeProjects = undefined
    useProjectsStore.setState({
      projects: [],
      presentationProjects: [],
      runtimeProjectMembershipActive: false,
      activeProjectId: null,
      manualProjectOrder: [],
    })
  })

  test('selecting a live-only project leaves catalog membership out of settings after authority revocation', () => {
    useProjectsStore.getState().synchronizeFromSettings({
      projects: [{ id: 'settings-project', path: '/settings-project' }],
    })
    useProjectsStore.getState().synchronizeFromRuntimeProjects([
      { worktree: '/gateway-project' },
      { worktree: '/removed-live-project' },
    ], { liveCatalog: true })

    const removedProject = useProjectsStore.getState().projects.find((project) => project.path === '/removed-live-project')
    if (!removedProject) throw new Error('live-only project was not created')

    useProjectsStore.getState().setActiveProject(removedProject.id)

    const selected = useProjectsStore.getState()
    expect(selected.activeProjectId).toBe(removedProject.id)
    expect(selected.presentationProjects.map((project) => project.path)).toEqual(['/settings-project'])
    expect(settingsWrites.filter((changes) => changes.projects).at(-1)).toEqual({
      projects: selected.presentationProjects,
      activeProjectId: removedProject.id,
    })

    useProjectsStore.getState().synchronizeFromRuntimeProjects([
      { worktree: '/gateway-project' },
    ], { liveCatalog: true })
    useProjectsStore.getState().synchronizeFromRuntimeProjects([], { liveCatalog: false })

    const released = useProjectsStore.getState()
    expect(released.runtimeProjectMembershipActive).toBe(false)
    expect(released.projects.map((project) => project.path)).toEqual(['/settings-project'])
  })

  test('persists a live-only project before discovering its icon without changing membership authority', async () => {
    const settings: DesktopSettings = {
      projects: [{ id: 'settings-project', path: '/settings-project' }],
    }
    useProjectsStore.getState().synchronizeFromSettings(settings)
    useProjectsStore.getState().synchronizeFromRuntimeProjects([
      { worktree: '/gateway-project' },
      { worktree: '/unmaterialized-project' },
    ], { liveCatalog: true })

    const gatewayProject = useProjectsStore.getState().projects.find((project) => project.path === '/gateway-project')
    if (!gatewayProject) throw new Error('gateway project was not created')
    expect(useProjectsStore.getState().presentationProjects.map((project) => project.path)).toEqual(['/settings-project'])
    const result = await useProjectsStore.getState().discoverProjectIcon(gatewayProject.id)
    expect(result).toEqual({ ok: true, skipped: true })

    expect(routeProjects?.map((project) => project.path)).toEqual([
      '/settings-project',
      '/gateway-project',
    ])
    expect(useProjectsStore.getState().runtimeProjectMembershipActive).toBe(true)
    expect(useProjectsStore.getState().projects.map((project) => project.path)).toEqual([
      '/gateway-project',
      '/unmaterialized-project',
    ])
  })
})
