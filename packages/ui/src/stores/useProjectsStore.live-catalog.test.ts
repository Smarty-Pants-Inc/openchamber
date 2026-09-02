import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { ProjectEntry } from '@/lib/api/types'
import type { DesktopSettings } from '@/lib/desktop'

let settingsWrites: Array<{ projects?: ProjectEntry[] }> = []
let routeProjects: ProjectEntry[] | undefined

mock.module('@/lib/persistence', () => ({
  updateDesktopSettings: async (changes: { projects?: ProjectEntry[] }) => {
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
