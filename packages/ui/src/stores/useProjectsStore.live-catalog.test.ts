import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { ProjectEntry } from '@/lib/api/types'
import type { DesktopSettings } from '@/lib/desktop'
import { createProjectIdFromPath } from '@/lib/projectId';

class TestFileReader {
  result = 'data:image/png;base64,eA=='
  onload: (() => void) | null = null
  onerror: ((error: unknown) => void) | null = null

  readAsDataURL() {
    queueMicrotask(() => this.onload?.())
  }
}

Object.defineProperty(globalThis, 'FileReader', { value: TestFileReader, configurable: true })

let settingsWrites: Array<Partial<DesktopSettings>> = []
let durableSettingsWrites: Array<Partial<DesktopSettings>> = []
let pendingSettingsChanges: Partial<DesktopSettings> | null = null
let settingsFlushWaiters: Array<() => void> = []
let settingsFlushScheduled = false
let routeProjects: ProjectEntry[] | undefined
let runtimeFetchCalls: string[] = []
let runtimeApiBaseUrl = 'https://runtime-a.example'
let runtimeKey = 'runtime-a'
let runtimeTransportEpoch = 0
let materializationGate: Promise<void> | null = null
let iconResponseGate: Promise<void> | null = null
let iconResponseStatus = 200
let iconResponsePayload: Record<string, unknown> = { skipped: true }
let settingsSaveState: 'idle' | 'saving' | 'error' = 'idle'
let coalesceSettingsWrites = false
let settingsSaveShouldFail = false
let revokeMembershipDuringSave = false
let runtimeFetchStarted: Promise<void> = Promise.resolve()
let resolveRuntimeFetchStarted: (() => void) | null = null

const flushSettingsQueue = async () => {
  settingsFlushScheduled = false
  const changes = pendingSettingsChanges
  pendingSettingsChanges = null
  const waiters = settingsFlushWaiters
  settingsFlushWaiters = []
  if (!changes) {
    waiters.forEach((resolve) => resolve())
    return
  }
  if (materializationGate) await materializationGate
  durableSettingsWrites.push(changes)
  waiters.forEach((resolve) => resolve())
}

const enqueueSettingsChanges = (changes: Partial<DesktopSettings>) => {
  pendingSettingsChanges = { ...(pendingSettingsChanges ?? {}), ...changes }
  if (settingsFlushScheduled) return
  settingsFlushScheduled = true
  queueMicrotask(() => { void flushSettingsQueue() })
}

const sanitizeProjectsForTest = (value: unknown): DesktopSettings['projects'] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const result: NonNullable<DesktopSettings['projects']> = [];
  const seenIds = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as Record<string, unknown>;
    const path = typeof candidate.path === 'string'
      ? candidate.path.trim().replace(/\\/g, '/').replace(/\/+$/, '')
      : '';
    const id = path ? createProjectIdFromPath(path) : null;
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);
    result.push({ ...candidate, id, path });
  }
  return result.length > 0 || value.length === 0 ? result : undefined;
};


mock.module('@/lib/persistence', () => ({
  sanitizeProjects: sanitizeProjectsForTest,
  sanitizeWebSettings: (value: unknown) => value && typeof value === 'object' ? value as DesktopSettings : null,
  getSettingsSaveState: () => settingsSaveState,
  updateDesktopSettings: (changes: Partial<DesktopSettings>) => {
    settingsWrites.push(changes)
    if (revokeMembershipDuringSave) {
      revokeMembershipDuringSave = false
      useProjectsStore.getState().synchronizeFromRuntimeProjects([], { liveCatalog: false })
    }
    if (settingsSaveShouldFail) {
      settingsSaveState = 'error'
      return Promise.reject(new Error('settings save failed'))
    }
    if (!coalesceSettingsWrites) {
      if (materializationGate) {
        settingsSaveState = 'saving'
        return materializationGate.then(() => {
          settingsSaveState = 'idle'
        })
      }
      settingsSaveState = 'idle'
      return Promise.resolve()
    }
    settingsSaveState = 'saving'
    enqueueSettingsChanges(changes)
    return new Promise<void>((resolve) => {
      settingsFlushWaiters.push(() => {
        settingsSaveState = 'idle'
        resolve()
      })
    })
  },
}))

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: async (url: string) => {
    runtimeFetchCalls.push(url)
    routeProjects = coalesceSettingsWrites
      ? durableSettingsWrites.at(-1)?.projects
      : settingsWrites.at(-1)?.projects
    resolveRuntimeFetchStarted?.()
    resolveRuntimeFetchStarted = null
    await iconResponseGate
    return new Response(JSON.stringify(iconResponsePayload), {
      status: iconResponseStatus,
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
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const switchTestRuntime = (nextRuntimeKey = 'runtime-b') => {
  runtimeApiBaseUrl = 'https://runtime-b.example'
  runtimeKey = nextRuntimeKey
  runtimeTransportEpoch += 1
}

const bootstrapPresentedProject = (): ProjectEntry => {
  useProjectsStore.getState().synchronizeFromSettings({
    projects: [{ id: 'live-project', path: '/live-project' }],
  })
  useProjectsStore.getState().synchronizeFromRuntimeProjects([
    { worktree: '/live-project' },
  ], { liveCatalog: true })
  const project = useProjectsStore.getState().projects[0]
  if (!project) throw new Error('presented project was not created')
  return project
}

describe('live catalog selection and icon materialization', () => {
  beforeEach(() => {
    settingsWrites = []
    durableSettingsWrites = []
    pendingSettingsChanges = null
    settingsFlushWaiters = []
    settingsFlushScheduled = false
    routeProjects = undefined
    runtimeFetchCalls = []
    runtimeApiBaseUrl = 'https://runtime-a.example'
    runtimeKey = 'runtime-a'
    runtimeTransportEpoch = 0
    materializationGate = null
    iconResponseGate = null
    iconResponseStatus = 200
    iconResponsePayload = { skipped: true }
    coalesceSettingsWrites = false
    revokeMembershipDuringSave = false
    settingsSaveState = 'idle'
    settingsSaveShouldFail = false
    const started = createDeferred<void>()
    runtimeFetchStarted = started.promise
    resolveRuntimeFetchStarted = () => started.resolve(undefined)
    useProjectsStore.setState({
      projects: [],
      presentationProjects: [],
      runtimeProjectMembershipActive: false,
      projectMembershipGeneration: 0,
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

  test('serializes overlapping icon materializations through the coalescing settings queue', async () => {
    useProjectsStore.getState().synchronizeFromSettings({
      projects: [{ id: 'settings-project', path: '/settings-project' }],
    })
    useProjectsStore.getState().synchronizeFromRuntimeProjects([
      { worktree: '/live-project-a' },
      { worktree: '/live-project-b' },
    ], { liveCatalog: true })
    const projects = useProjectsStore.getState().projects
    const liveA = projects.find((project) => project.path === '/live-project-a')
    const liveB = projects.find((project) => project.path === '/live-project-b')
    if (!liveA || !liveB) throw new Error('live projects were not created')

    settingsWrites = []
    durableSettingsWrites = []
    coalesceSettingsWrites = true
    const deferred = createDeferred<void>()
    materializationGate = deferred.promise

    const first = useProjectsStore.getState().discoverProjectIcon(liveA.id)
    const second = useProjectsStore.getState().discoverProjectIcon(liveB.id)
    expect(settingsWrites).toHaveLength(1)
    expect(durableSettingsWrites).toEqual([])

    deferred.resolve(undefined)
    expect(await Promise.all([first, second])).toEqual([
      { ok: true, skipped: true },
      { ok: true, skipped: true },
    ])
    expect(durableSettingsWrites.map((changes) => changes.projects?.map((project) => project.path))).toEqual([
      ['/settings-project', '/live-project-a'],
      ['/settings-project', '/live-project-a', '/live-project-b'],
    ])
    expect(useProjectsStore.getState().presentationProjects.map((project) => project.path)).toEqual([
      '/settings-project',
      '/live-project-a',
      '/live-project-b',
    ])
  })

  test('persists only presented and explicitly targeted live projects', () => {
    useProjectsStore.getState().synchronizeFromSettings({
      projects: [{ id: 'presented-project', path: '/presented-project' }],
    })
    useProjectsStore.getState().synchronizeFromRuntimeProjects([
      { worktree: '/presented-project' },
      { worktree: '/live-project-a' },
      { worktree: '/live-project-b' },
    ], { liveCatalog: true })
    settingsWrites = []

    const state = useProjectsStore.getState()
    const presented = state.projects.find((project) => project.path === '/presented-project')
    const liveOnly = state.projects.find((project) => project.path === '/live-project-a')
    if (!presented || !liveOnly) throw new Error('test projects were not created')

    state.renameProject(presented.id, 'Renamed')
    expect(settingsWrites.at(-1)?.projects?.map((project) => project.path)).toEqual(['/presented-project'])

    state.updateProjectMeta(liveOnly.id, { color: '#123456' })
    expect(settingsWrites.at(-1)?.projects?.map((project) => project.path)).toEqual([
      '/presented-project',
      '/live-project-a',
    ])
    expect(useProjectsStore.getState().presentationProjects.some((project) => project.path === '/live-project-b')).toBe(false)
  })

  test('preserves cleaned manual order and appends new projects in normal and live syncs', () => {
    useProjectsStore.getState().synchronizeFromSettings({
      projects: [{ id: 'normal-a', path: '/normal-a' }, { id: 'normal-b', path: '/normal-b' }, { id: 'normal-c', path: '/normal-c' }],
    })
    const normalProjects = useProjectsStore.getState().projects
    const normalA = normalProjects.find((project) => project.path === '/normal-a')
    const normalB = normalProjects.find((project) => project.path === '/normal-b')
    const normalC = normalProjects.find((project) => project.path === '/normal-c')
    if (!normalA || !normalB || !normalC) throw new Error('normal projects were not created')
    useProjectsStore.setState({ manualProjectOrder: [normalC.id, normalA.id, 'missing', normalA.id] })

    useProjectsStore.getState().synchronizeFromSettings({
      projects: [{ id: 'normal-b', path: '/normal-b' }, { id: 'normal-new', path: '/normal-new' }, { id: 'normal-a', path: '/normal-a' }],
    })
    const normalNew = useProjectsStore.getState().projects.find((project) => project.path === '/normal-new')
    if (!normalNew) throw new Error('new normal project was not created')
    expect(useProjectsStore.getState().manualProjectOrder).toEqual([normalA.id, normalB.id, normalNew.id])

    useProjectsStore.getState().synchronizeFromSettings({
      projects: [{ id: 'live-a', path: '/live-a' }, { id: 'live-b', path: '/live-b' }],
    })
    useProjectsStore.getState().synchronizeFromRuntimeProjects([
      { worktree: '/live-a' },
      { worktree: '/live-b' },
      { worktree: '/live-only' },
    ], { liveCatalog: true })
    const liveProjects = useProjectsStore.getState().projects
    const liveA = liveProjects.find((project) => project.path === '/live-a')
    const liveB = liveProjects.find((project) => project.path === '/live-b')
    const liveOnly = liveProjects.find((project) => project.path === '/live-only')
    if (!liveA || !liveB || !liveOnly) throw new Error('live projects were not created')
    useProjectsStore.setState({ manualProjectOrder: [liveB.id, 'missing'] })

    useProjectsStore.getState().synchronizeFromSettings({
      projects: [{ id: 'live-b', path: '/live-b' }, { id: 'live-a', path: '/live-a' }],
    })
    expect(useProjectsStore.getState().manualProjectOrder).toEqual([liveB.id, liveA.id, liveOnly.id])
  })

  test('does not reuse presented metadata as stale fallback for a live-only project', () => {
    const presented: ProjectEntry = { id: 'presented', path: '/stale-presented', label: 'Stale label' }
    const liveOnly: ProjectEntry = { id: 'live-only', path: '/live-only', label: 'Keep live metadata' }
    useProjectsStore.setState({
      projects: [presented, liveOnly],
      presentationProjects: [presented],
      runtimeProjectMembershipActive: true,
      activeProjectId: liveOnly.id,
      manualProjectOrder: [presented.id, liveOnly.id],
    })

    useProjectsStore.getState().synchronizeFromSettings({ projects: [] })

    const state = useProjectsStore.getState()
    expect(state.projects.find((project) => project.path === '/stale-presented')?.label).toBe('stale-presented')
    expect(state.projects.find((project) => project.path === '/live-only')?.label).toBe('Keep live metadata')
  })

  test('preserves live presentation metadata when a partial settings patch omits projects', () => {
    const presented: ProjectEntry = {
      id: 'presented',
      path: '/presented',
      label: 'Presented label',
      icon: 'folder',
      color: '#123456',
      defaultModel: 'provider/model',
    }
    const liveOnly: ProjectEntry = {
      id: 'live-only',
      path: '/live-only',
      label: 'Live label',
      color: '#654321',
    }
    useProjectsStore.setState({
      projects: [presented, liveOnly],
      presentationProjects: [presented],
      runtimeProjectMembershipActive: true,
      activeProjectId: liveOnly.id,
      manualProjectOrder: [presented.id, liveOnly.id],
    })

    useProjectsStore.getState().synchronizeFromSettings({ sidebarProjectSortOrder: 'a-z' })

    const state = useProjectsStore.getState()
    expect(state.presentationProjects).toEqual([presented])
    const presentedProject = state.projects.find((project) => project.path === presented.path)
    expect(presentedProject?.path).toBe(presented.path)
    expect(presentedProject?.label).toBe(presented.label)
    expect(presentedProject?.icon).toBe(presented.icon)
    expect(presentedProject?.color).toBe(presented.color)
    expect(presentedProject?.defaultModel).toBe(presented.defaultModel)
    const liveProject = state.projects.find((project) => project.path === liveOnly.path)
    expect(liveProject?.path).toBe(liveOnly.path)
    expect(liveProject?.label).toBe(liveOnly.label)
    expect(liveProject?.color).toBe(liveOnly.color)
  })

  test('guards reorder while the runtime owns membership and reorders after release', () => {
    useProjectsStore.getState().synchronizeFromSettings({ projects: [{ id: 'reorder-a', path: '/reorder-a' }] })
    useProjectsStore.getState().synchronizeFromRuntimeProjects([
      { worktree: '/reorder-a' },
      { worktree: '/reorder-b' },
      { worktree: '/reorder-c' },
    ], { liveCatalog: true })
    settingsWrites = []

    const beforeLive = useProjectsStore.getState().projects.map((project) => project.path)
    useProjectsStore.getState().reorderProjects(0, 2)
    // The runtime owns membership: reorder is a no-op with no settings write.
    expect(settingsWrites).toEqual([])
    expect(useProjectsStore.getState().projects.map((project) => project.path)).toEqual(beforeLive)

    useProjectsStore.getState().synchronizeFromRuntimeProjects([], { liveCatalog: false })
    const released: ProjectEntry[] = [
      { id: 'reorder-a', path: '/reorder-a' },
      { id: 'reorder-b', path: '/reorder-b' },
      { id: 'reorder-c', path: '/reorder-c' },
    ]
    useProjectsStore.getState().synchronizeFromSettings({ projects: released })
    settingsWrites = []

    const beforeInvalid = useProjectsStore.getState().projects.map((project) => project.path)
    useProjectsStore.getState().reorderProjects(-1, 0)
    expect(settingsWrites).toEqual([])
    expect(useProjectsStore.getState().projects.map((project) => project.path)).toEqual(beforeInvalid)

    useProjectsStore.getState().reorderProjects(0, 2)
    expect(settingsWrites.at(-1)?.projects?.map((project) => project.path)).toEqual([
      '/reorder-b',
      '/reorder-c',
      '/reorder-a',
    ])
  })

  test('rolls back live presentation materialization when settings save fails', async () => {
    useProjectsStore.getState().synchronizeFromSettings({ projects: [{ id: 'settings-project', path: '/settings-project' }] })
    useProjectsStore.getState().synchronizeFromRuntimeProjects([{ worktree: '/live-icon-project' }], { liveCatalog: true })
    const project = useProjectsStore.getState().projects[0]
    if (!project) throw new Error('live icon project was not created')
    settingsSaveShouldFail = true

    const result = await useProjectsStore.getState().discoverProjectIcon(project.id)

    expect(result).toEqual({ ok: false, error: 'Failed to save project settings' })
    expect(runtimeFetchCalls).toEqual([])
    expect(useProjectsStore.getState().presentationProjects.map((entry) => entry.path)).toEqual(['/settings-project'])
  })

  test('does not commit or route a live-only project after membership authority is lost during save', async () => {
    useProjectsStore.getState().synchronizeFromSettings({
      projects: [{ id: 'settings-project', path: '/settings-project' }],
    })
    useProjectsStore.getState().synchronizeFromRuntimeProjects([{ worktree: '/live-project' }], { liveCatalog: true })
    const project = useProjectsStore.getState().projects[0]
    if (!project) throw new Error('live project was not created')
    revokeMembershipDuringSave = true

    const result = await useProjectsStore.getState().discoverProjectIcon(project.id)

    expect(result).toEqual({ ok: false, error: 'Runtime changed' })
    expect(runtimeFetchCalls).toEqual([])
    expect(useProjectsStore.getState().runtimeProjectMembershipActive).toBe(false)
    expect(useProjectsStore.getState().presentationProjects.map((entry) => entry.path)).toEqual(['/settings-project'])
  })

  test('retains a cached live-only selection through a partial catalog and a logical-key relay switch', () => {
    runtimeKey = 'logical-runtime-cache-test'
    runtimeApiBaseUrl = 'https://lan-runtime.example'
    useProjectsStore.getState().synchronizeFromSettings({ projects: [{ id: 'cache-a', path: '/cache-a' }] })
    useProjectsStore.getState().synchronizeFromRuntimeProjects([
      { worktree: '/cache-a' },
      { worktree: '/cache-live-only' },
    ], { liveCatalog: true })
    const liveOnly = useProjectsStore.getState().projects.find((project) => project.path === '/cache-live-only')
    if (!liveOnly) throw new Error('cached live-only project was not created')
    useProjectsStore.getState().setActiveProject(liveOnly.id)

    runtimeApiBaseUrl = 'https://relay-runtime.example'
    runtimeTransportEpoch += 1
    useProjectsStore.getState().resetForRuntimeSwitch()
    useProjectsStore.getState().synchronizeFromSettings({ projects: [{ id: 'cache-a', path: '/cache-a' }] })
    useProjectsStore.getState().synchronizeFromRuntimeProjects([{ worktree: '/cache-a' }], { liveCatalog: true })
    useProjectsStore.getState().synchronizeFromRuntimeProjects([
      { worktree: '/cache-a' },
      { worktree: '/cache-live-only' },
    ], { liveCatalog: true })

    expect(useProjectsStore.getState().activeProjectId).toBe(liveOnly.id)
  })

  test('ignores an upload response from an old runtime', async () => {
    const project = bootstrapPresentedProject()
    const deferred = createDeferred<void>()
    iconResponseGate = deferred.promise
    iconResponsePayload = { settings: { projects: [{ path: '/stale-server-project' }] } }

    const pending = useProjectsStore.getState().uploadProjectIcon(
      project.id,
      new File(['icon'], 'icon.png', { type: 'image/png' }),
    )
    await runtimeFetchStarted
    expect(runtimeFetchCalls).toHaveLength(1)
    switchTestRuntime()
    deferred.resolve(undefined)

    expect(await pending).toEqual({ ok: false, error: 'Runtime changed' })
    expect(useProjectsStore.getState().projects.map((entry) => entry.path)).toEqual(['/live-project'])
  })

  test('ignores a discover response from an old runtime', async () => {
    const project = bootstrapPresentedProject()
    const deferred = createDeferred<void>()
    iconResponseGate = deferred.promise
    iconResponsePayload = { settings: { projects: [{ path: '/stale-server-project' }] } }

    const pending = useProjectsStore.getState().discoverProjectIcon(project.id, { force: true })
    await runtimeFetchStarted
    expect(runtimeFetchCalls).toHaveLength(1)
    switchTestRuntime()
    deferred.resolve(undefined)

    expect(await pending).toEqual({ ok: false, error: 'Runtime changed' })
    expect(useProjectsStore.getState().projects.map((entry) => entry.path)).toEqual(['/live-project'])
  })

  test('ignores a remove response from an old runtime', async () => {
    const project = bootstrapPresentedProject()
    const deferred = createDeferred<void>()
    iconResponseGate = deferred.promise
    iconResponsePayload = { settings: { projects: [{ path: '/stale-server-project' }] } }

    const pending = useProjectsStore.getState().removeProjectIcon(project.id)
    await runtimeFetchStarted
    expect(runtimeFetchCalls).toHaveLength(1)
    switchTestRuntime()
    deferred.resolve(undefined)

    expect(await pending).toEqual({ ok: false, error: 'Runtime changed' })
    expect(useProjectsStore.getState().projects.map((entry) => entry.path)).toEqual(['/live-project'])
  })

})
