import { describe, expect, test } from "bun:test"
import type { OpencodeClient, Project } from "@opencode-ai/sdk/v2/client"
import {
  bootstrapDirectory,
  bootstrapGlobal,
  createProjectCatalogRefresh,
  hasLiveProjectCatalogCapability,
  LIVE_PROJECT_CATALOG_RUNTIME,
} from "./bootstrap"
import { INITIAL_STATE, type State } from "./types"
import { getRuntimeKey, getRuntimeTransportEpoch, switchRuntimeEndpoint } from "@/lib/runtime-switch"

const createSdk = (options?: {
  commandList?: () => Promise<{ data: unknown[] }>
  projectList?: () => Promise<{ data: Project[] }>
}) => ({
  project: {
    current: async () => ({ data: { id: "project-a" } }),
    list: options?.projectList ?? (async () => ({ data: [] })),
  },
  global: { config: { get: async () => ({ data: {} }) } },
  config: { get: async () => ({ data: {} }) },
  path: { get: async () => ({ data: { state: "", config: "", worktree: "/repo", directory: "/repo", home: "/home" } }) },
  session: { status: async () => ({ data: {} }) },
  command: { list: options?.commandList ?? (async () => ({ data: [] })) },
  mcp: { status: async () => ({ data: {} }) },
  lsp: { status: async () => ({ data: [] }) },
  vcs: { get: async () => ({ data: { branch: "main" } }) },
  question: { list: async () => ({ data: [] }) },
  permission: { list: async () => ({ data: [] }) },
}) as unknown as OpencodeClient

const createState = (): State => ({
  ...INITIAL_STATE,
  message: {},
  part: {},
})

const project = { id: "project-a", worktree: "/repo" } as Project

describe("bootstrapDirectory", () => {
  test("prioritizes session loading without waiting for deferred fields", async () => {
    let state = createState()
    let deferredStarted = false
    let resolveDeferred!: () => void
    const deferred = new Promise<{ data: unknown[] }>((resolve) => {
      resolveDeferred = () => resolve({ data: [] })
    })
    let resolveSessions!: () => void
    const sessions = new Promise<void>((resolve) => {
      resolveSessions = resolve
    })
    let settled = false
    const sdk = createSdk({
      commandList: async () => {
        deferredStarted = true
        return deferred
      },
    })
    const bootstrapping = bootstrapDirectory({
      directory: "/repo",
      sdk,
      getState: () => state,
      set: (patch) => {
        state = { ...state, ...patch }
      },
      global: { config: {}, projects: [project] },
      loadSessions: () => sessions,
    }).then((result) => {
      settled = true
      return result
    })

    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(deferredStarted).toBe(false)
    resolveSessions()

    expect(await bootstrapping).toBe("complete")
    expect(state.status).toBe("complete")
    expect(deferredStarted).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(deferredStarted).toBe(true)
    resolveDeferred()
  })

  test("reports session-list failure without clearing existing state", async () => {
    let state = { ...createState(), session: [{ id: "cached" }] as State["session"] }
    const result = await bootstrapDirectory({
      directory: "/repo",
      sdk: createSdk(),
      getState: () => state,
      set: (patch) => {
        state = { ...state, ...patch }
      },
      global: { config: {}, projects: [project] },
      loadSessions: async () => {
        throw new Error("unavailable")
      },
    })

    expect(result).toBe("failed")
    expect(state.session.map((session) => session.id)).toEqual(["cached"])
  })

  test("rejects stale work before committing", async () => {
    const state = createState()
    let commits = 0
    const result = await bootstrapDirectory({
      directory: "/repo",
      sdk: createSdk(),
      getState: () => state,
      set: () => {
        commits += 1
      },
      isStale: () => true,
      global: { config: {}, projects: [project] },
      loadSessions: async () => undefined,
    })

    expect(result).toBe("stale")
    expect(commits).toBe(0)
  })
})

describe("runtime project catalog refresh", () => {
  test("requires the explicit Smarty-OC runtime identity", () => {
    expect(hasLiveProjectCatalogCapability({ runtime: "web" })).toBe(false)
    expect(hasLiveProjectCatalogCapability({ runtime: LIVE_PROJECT_CATALOG_RUNTIME })).toBe(true)
  })

  test("keeps a normal runtime catalog visible without granting membership authority", async () => {
    const runtimeProjects = [project]
    const sdk = createSdk({ projectList: async () => ({ data: runtimeProjects }) })
    let publishedProjects: Project[] | null = []
    let liveCatalog: boolean | null = true
    const refresh = createProjectCatalogRefresh(
      sdk,
      (projects, authority) => {
        publishedProjects = projects
        liveCatalog = authority.liveCatalog
      },
      { getLiveProjectCatalogCapability: async () => false },
    )

    await bootstrapGlobal(sdk, () => undefined, undefined, refresh)

    expect(publishedProjects).toEqual(runtimeProjects)
    expect(liveCatalog).toBe(false)
  })

  test("releases ordinary runtime authority before its project list failure rejects", async () => {
    let resolveHealth!: (value: boolean | null) => void
    const health = new Promise<boolean | null>((resolve) => {
      resolveHealth = resolve
    })
    const failure = new Error("project.list unavailable")
    let rejectProjects!: (error: Error) => void
    const projects = new Promise<{ data: Project[] }>((_resolve, reject) => {
      rejectProjects = reject
    })
    const published: Array<{ projects: Project[] | null; liveCatalog: boolean | null }> = []
    let resolveAuthority!: () => void
    const authorityReleased = new Promise<void>((resolve) => {
      resolveAuthority = resolve
    })
    const refresh = createProjectCatalogRefresh(
      createSdk({ projectList: async () => await projects }),
      (nextProjects, authority) => {
        published.push({ projects: nextProjects, liveCatalog: authority.liveCatalog })
        if (nextProjects === null && authority.liveCatalog === false) resolveAuthority()
      },
      { getLiveProjectCatalogCapability: async () => await health },
    )

    const refreshing = refresh()
    resolveHealth(false)
    await authorityReleased

    expect(published).toEqual([{ projects: null, liveCatalog: false }])
    rejectProjects(failure)
    await expect(refreshing).rejects.toThrow(failure.message)
    expect(published).toEqual([{ projects: null, liveCatalog: false }])
  })

  test("clears a rejected catalog request so the next invalidation can refresh", async () => {
    const failure = new Error("project.list unavailable")
    let calls = 0
    const published: Array<Project[] | null> = []
    const refresh = createProjectCatalogRefresh(
      createSdk({
        projectList: async () => {
          calls += 1
          if (calls === 1) throw failure
          return { data: [project] }
        },
      }),
      (projects) => {
        published.push(projects)
      },
      { getLiveProjectCatalogCapability: async () => true },
    )
    const first = refresh()
    expect(refresh()).toBe(first)
    await expect(first).rejects.toThrow(failure.message)
    await refresh()

    expect(calls).toBe(2)
    expect(published).toEqual([[project]])
  })

  test("rejects a nonempty catalog with no valid worktrees", async () => {
    const failure = new Error("project.list returned no valid worktrees")
    const refresh = createProjectCatalogRefresh(
      createSdk({ projectList: async () => ({ data: [{ id: "invalid" } as Project] }) }),
      () => undefined,
      { getLiveProjectCatalogCapability: async () => true },
    )

    await expect(refresh()).rejects.toThrow(failure.message)
  })

  test("marks a gateway catalog as authoritative when its capability is present", async () => {
    const runtimeProjects = [project]
    let liveCatalog: boolean | null = false
    const refresh = createProjectCatalogRefresh(
      createSdk({ projectList: async () => ({ data: runtimeProjects }) }),
      (_projects, authority) => {
        liveCatalog = authority.liveCatalog
      },
      { getLiveProjectCatalogCapability: async () => true },
    )

    await refresh()

    expect(liveCatalog).toBe(true)
  })

  test("keeps an unknown health identity non-authoritative", async () => {
    let liveCatalog: boolean | null = false
    const refresh = createProjectCatalogRefresh(
      createSdk({ projectList: async () => ({ data: [project] }) }),
      (_projects, authority) => {
        liveCatalog = authority.liveCatalog
      },
      { getLiveProjectCatalogCapability: async () => null },
    )

    await refresh()

    expect(liveCatalog).toBeNull()
  })

  test("drops a catalog response after a same-key transport switch", async () => {
    switchRuntimeEndpoint({ apiBaseUrl: "https://catalog-before.test", runtimeKey: "catalog-test" })
    const runtimeKey = getRuntimeKey()
    const transportEpoch = getRuntimeTransportEpoch()
    let resolveProjects!: (result: { data: Project[] }) => void
    const projects = new Promise<{ data: Project[] }>((resolve) => {
      resolveProjects = resolve
    })
    const published: Array<Project[] | null> = []
    const refresh = createProjectCatalogRefresh(
      createSdk({ projectList: async () => await projects }),
      (nextProjects) => {
        published.push(nextProjects)
      },
      {
        getLiveProjectCatalogCapability: async () => true,
        isCurrent: () => runtimeKey === getRuntimeKey() && transportEpoch === getRuntimeTransportEpoch(),
      },
    )

    const refreshing = refresh()
    switchRuntimeEndpoint({ apiBaseUrl: "https://catalog-after.test", runtimeKey })
    resolveProjects({ data: [project] })
    await refreshing

    expect(published).toEqual([])
  })

  test("does not publish after its provider generation changes", async () => {
    let resolveProjects!: (result: { data: Project[] }) => void
    const projects = new Promise<{ data: Project[] }>((resolve) => {
      resolveProjects = resolve
    })
    let ownerGeneration = 0
    const published: Array<Project[] | null> = []
    const refresh = createProjectCatalogRefresh(
      createSdk({ projectList: async () => await projects }),
      (nextProjects) => {
        published.push(nextProjects)
      },
      {
        getLiveProjectCatalogCapability: async () => true,
        getOwnerGeneration: () => ownerGeneration,
      },
    )

    const refreshing = refresh()
    ownerGeneration += 1
    resolveProjects({ data: [project] })
    await refreshing

    expect(published).toEqual([])
  })
})
