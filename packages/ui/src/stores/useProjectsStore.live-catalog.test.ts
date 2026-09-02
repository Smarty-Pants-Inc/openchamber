import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { ProjectEntry } from '@/lib/api/types'
import type { DesktopSettings } from '@/lib/desktop'

let settingsWrites: Array<Partial<DesktopSettings>> = []
let routeProjects: ProjectEntry[] | undefined
let runtimeFetchCalls: string[] = []
let runtimeApiBaseUrl = 'https://runtime-a.example'
let runtimeKey = 'runtime-a'
let runtimeTransportEpoch = 0
let materializationGate: Promise<void> | null = null

mock.module('@/lib/persistence', () => ({
  updateDesktopSettings: (changes: Partial<DesktopSettings>) => {
    settingsWrites.push(changes)
    return materializationGate ?? Promise.resolve()
  },
}))

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: async (url: string) => {
    runtimeFetchCalls.push(url)
    routeProjects = settingsWrites.at(-1)?.projects
    return new Response(JSON.stringify({ skipped: true }), {
      headers: { 'Content-Type': 'application/json' },
    })
  },
  bindRuntimeTransport: () => {
    throw new Error('bound transport fixture is not installed')
  },
}))

mock.module('@/lib/runtime-switch', () => ({
  getRuntimeApiBaseUrl: () => runtimeApiBaseUrl,
  getRuntimeKey: () => runtimeKey,
  getRuntimeTransportEpoch: () => runtimeTransportEpoch,
  subscribeRuntimeEndpointChanged: () => () => undefined,
  subscribeRuntimeEndpointWillChange: () => () => undefined,
}))

// The test mocks must be registered before this module captures its runtime dependencies.
const { useProjectsStore } = await import('./useProjectsStore')

const createDeferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

const switchTestRuntime = (nextRuntimeKey = 'runtime-b') => {
  runtimeApiBaseUrl = 'https://runtime-b.example'
  runtimeKey = nextRuntimeKey
  runtimeTransportEpoch += 1
}

describe('live catalog selection and icon materialization', () => {
  beforeEach(() => {
    settingsWrites = []
    routeProjects = undefined
    runtimeFetchCalls = []
    runtimeApiBaseUrl = 'https://runtime-a.example'
    runtimeKey = 'runtime-a'
    runtimeTransportEpoch = 0
    materializationGate = null
    useProjectsStore.setState({
      projects: [],
      presentationProjects: [],
      runtimeProjectMembershipActive: false,
      activeProjectId: null,
      manualProjectOrder: [],
    })
    useProjectsStore.getState().synchronizeFromRuntimeProjects([], { liveCatalog: false })
  })

  test('keeps a live-only selection local and restores it after reload bootstrap', () => {
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
    const selectionWrite = settingsWrites.filter((changes) => changes.projects).at(-1)
    expect(selectionWrite).toEqual({ projects: selected.presentationProjects })
    expect(Object.hasOwn(selectionWrite ?? {}, 'activeProjectId')).toBe(false)

    useProjectsStore.getState().resetForRuntimeSwitch()
    const reset = useProjectsStore.getState()
    expect(reset.activeProjectId).toBe(reset.presentationProjects[0]?.id ?? null)

    useProjectsStore.getState().synchronizeFromSettings({
      projects: [{ id: 'settings-project', path: '/settings-project', label: 'Reloaded project' }],
      activeProjectId: reset.presentationProjects[0]?.id,
    })
    useProjectsStore.getState().synchronizeFromRuntimeProjects([
      { worktree: '/gateway-project' },
      { worktree: '/removed-live-project' },
    ], { liveCatalog: true })
    expect(useProjectsStore.getState().activeProjectId).toBe(removedProject.id)

    useProjectsStore.getState().synchronizeFromRuntimeProjects([
      { worktree: '/gateway-project' },
    ], { liveCatalog: true })
    useProjectsStore.getState().synchronizeFromRuntimeProjects([], { liveCatalog: false })

    const released = useProjectsStore.getState()
    expect(released.runtimeProjectMembershipActive).toBe(false)
    expect(released.projects.map((project) => project.path)).toEqual(['/settings-project'])
  })

  test('keeps a live-only id-only selection out of settings', () => {
    useProjectsStore.getState().synchronizeFromSettings({
      projects: [{ id: 'settings-project', path: '/settings-project' }],
    })
    useProjectsStore.getState().synchronizeFromRuntimeProjects([
      { worktree: '/live-project-a' },
      { worktree: '/live-project-b' },
    ], { liveCatalog: true })
    const liveProject = useProjectsStore.getState().projects.find((project) => project.path === '/live-project-b')
    if (!liveProject) throw new Error('live project was not created')

    const writesBeforeSelection = settingsWrites.length
    useProjectsStore.getState().setActiveProjectIdOnly(liveProject.id)

    expect(useProjectsStore.getState().activeProjectId).toBe(liveProject.id)
    expect(settingsWrites).toHaveLength(writesBeforeSelection)
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

  test('does not discover a live-project icon after its transport changes during materialization', async () => {
    useProjectsStore.getState().synchronizeFromSettings({
      projects: [{ id: 'settings-project', path: '/settings-project' }],
    })
    useProjectsStore.getState().synchronizeFromRuntimeProjects([{ worktree: '/live-project' }], { liveCatalog: true })
    const project = useProjectsStore.getState().projects[0]
    if (!project) throw new Error('live project was not created')

    const deferred = createDeferred<void>()
    materializationGate = deferred.promise
    const pending = useProjectsStore.getState().discoverProjectIcon(project.id)
    expect(settingsWrites.at(-1)?.projects?.map((entry) => entry.path)).toEqual(['/settings-project', '/live-project'])

    switchTestRuntime('runtime-a')
    deferred.resolve(undefined)

    const result = await pending
    expect(result).toEqual({ ok: false, error: 'Runtime changed' })
    expect(runtimeFetchCalls).toEqual([])
  })

  test('does not upload a live-project icon after the runtime changes during materialization', async () => {
    useProjectsStore.getState().synchronizeFromSettings({
      projects: [{ id: 'settings-project', path: '/settings-project' }],
    })
    useProjectsStore.getState().synchronizeFromRuntimeProjects([{ worktree: '/live-project' }], { liveCatalog: true })
    const project = useProjectsStore.getState().projects[0]
    if (!project) throw new Error('live project was not created')

    const deferred = createDeferred<void>()
    materializationGate = deferred.promise
    const file = new File(['x'], 'icon.png', { type: 'image/png' })
    const pending = useProjectsStore.getState().uploadProjectIcon(project.id, file)
    expect(settingsWrites.at(-1)?.projects?.map((entry) => entry.path)).toEqual(['/settings-project', '/live-project'])

    switchTestRuntime()
    deferred.resolve(undefined)

    const result = await pending
    expect(result).toEqual({ ok: false, error: 'Runtime changed' })
    expect(runtimeFetchCalls).toEqual([])
  })

})
