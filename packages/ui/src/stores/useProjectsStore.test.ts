import { describe, expect, spyOn, test } from "bun:test"
import * as settings from "@/lib/persistence"
import type { ProjectEntry } from "@/lib/api/types"
import type { DesktopSettings } from "@/lib/desktop"
import { useProjectsStore } from "./useProjectsStore"
import { useDirectoryStore } from "./useDirectoryStore"
import { getDeferredSafeStorage } from "./utils/safeStorage"

describe("useProjectsStore settings synchronization", () => {
  test("treats a successful empty project snapshot as authoritative", () => {
    const project = { id: "project-a", path: "/repo", label: "Repo" } as ProjectEntry
    useProjectsStore.setState({
      projects: [project],
      activeProjectId: project.id,
      manualProjectOrder: [project.id],
    })

    useProjectsStore.getState().synchronizeFromSettings({ projects: [] } as DesktopSettings)

    expect(useProjectsStore.getState().projects).toEqual([])
    expect(useProjectsStore.getState().activeProjectId).toBe(null)
    expect(useProjectsStore.getState().manualProjectOrder).toEqual([])
  })

  test("a reconcile sync never adopts another window's active project", () => {
    useProjectsStore.setState({ managedCatalogStatus: "stock" })
    // Ids are path-derived inside the store's sanitizer, so seed real ones by
    // bootstrapping once and reading them back.
    const raw = { projects: [{ path: "/repo-a" }, { path: "/repo-b" }] } as DesktopSettings
    useProjectsStore.getState().synchronizeFromSettings(raw)
    const [first, second] = useProjectsStore.getState().projects
    useProjectsStore.setState({ activeProjectId: first.id })

    // The shared settings document carries window B's pointer; outside a
    // bootstrap this window keeps its own.
    useProjectsStore.getState().synchronizeFromSettings(
      { ...raw, activeProjectId: second.id } as DesktopSettings,
      { adoptActiveProject: false },
    )
    expect(useProjectsStore.getState().activeProjectId).toBe(first.id)

    // Unless its own project vanished from the list — then the incoming
    // pointer is better than a dangling one.
    useProjectsStore.getState().synchronizeFromSettings(
      { projects: [{ path: "/repo-b" }], activeProjectId: second.id } as DesktopSettings,
      { adoptActiveProject: false },
    )
    expect(useProjectsStore.getState().activeProjectId).toBe(second.id)

    // A bootstrap sync adopts as before.
    useProjectsStore.getState().synchronizeFromSettings(raw)
    useProjectsStore.setState({ activeProjectId: first.id })
    useProjectsStore.getState().synchronizeFromSettings(
      { ...raw, activeProjectId: second.id } as DesktopSettings,
    )
    expect(useProjectsStore.getState().activeProjectId).toBe(second.id)
  })
})

describe("bootstrap active pointer while discovery is pending", () => {
  // 3.13: a fresh browser's bootstrap adopted the shared active pointer (smarty-code) before managed discovery,
  // so it opened there instead of the remembered lastDirectory (smarty-dev).
  test("a managed catalog selects the remembered directory, not the held shared pointer", () => {
    const save = spyOn(settings, "updateDesktopSettings").mockResolvedValue(undefined)
    try {
      useProjectsStore.getState().resetManagedCatalog()
      useProjectsStore.setState({ projects: [], activeProjectId: null, manualProjectOrder: [] })
      getDeferredSafeStorage().setItem("lastDirectory", "/p/dev")
      getDeferredSafeStorage().removeItem("oc.browser.lastDirectory")
      useProjectsStore.getState().synchronizeFromSettings({ projects: [{ path: "/p/code" }] as never, activeProjectId: "path_L3AvY29kZQ",
        lastDirectory: "/p/dev" } as DesktopSettings, { adoptActiveProject: true })
      expect(useProjectsStore.getState().activeProjectId).toBe(null)
      useProjectsStore.getState().admitManagedCatalog()
      useProjectsStore.getState().applyManagedCatalog([{ id: "g-code", worktree: "/p/code" }, { id: "g-dev", worktree: "/p/dev" }])
      const dev = useProjectsStore.getState().managedProjects!.find(project => project.path === "/p/dev")
      expect(useProjectsStore.getState().activeProjectId).toBe(dev!.id)
      expect(save).not.toHaveBeenCalled()
    } finally {
      save.mockRestore()
      getDeferredSafeStorage().removeItem("lastDirectory")
      useProjectsStore.getState().resetManagedCatalog()
    }
  })
  test("a stock answer adopts the held shared pointer", () => {
    useProjectsStore.getState().resetManagedCatalog()
    useProjectsStore.setState({ projects: [], activeProjectId: null, manualProjectOrder: [] })
    const raw = { projects: [{ path: "/repo-a" }, { path: "/repo-b" }] } as DesktopSettings
    useProjectsStore.getState().synchronizeFromSettings(raw, { adoptActiveProject: false })
    const [, second] = useProjectsStore.getState().projects
    useProjectsStore.getState().synchronizeFromSettings({ ...raw, activeProjectId: second!.id } as DesktopSettings)
    expect(useProjectsStore.getState().activeProjectId).toBe(null)
    useProjectsStore.setState({ managedCatalogStatus: "stock" })
    expect(useProjectsStore.getState().activeProjectId).toBe(second!.id)
    useProjectsStore.getState().resetManagedCatalog()
  })
})

describe("held bootstrap pointer lifecycle (review/astra on OC#159)", () => {
  const hold = () => {
    useProjectsStore.getState().resetManagedCatalog()
    useProjectsStore.setState({ projects: [], activeProjectId: null, manualProjectOrder: [] })
    getDeferredSafeStorage().removeItem("oc.browser.lastDirectory")
    const raw = { projects: [{ path: "/repo-a" }, { path: "/repo-b" }] } as DesktopSettings
    useProjectsStore.getState().synchronizeFromSettings(raw, { adoptActiveProject: false })
    const [first, second] = useProjectsStore.getState().projects
    useProjectsStore.getState().synchronizeFromSettings({ ...raw, activeProjectId: first!.id } as DesktopSettings)
    return { first: first!, second: second! }
  }
  for (const choice of ["setActiveProject", "directory"] as const) test(`a newer explicit selection (${choice}) is not undone by the stock answer`, () => {
    const save = spyOn(settings, "updateDesktopSettings").mockResolvedValue(undefined)
    try {
      const { second } = hold()
      if (choice === "setActiveProject") useProjectsStore.getState().setActiveProject(second.id)
      else { useDirectoryStore.getState().setDirectory(second.path); useProjectsStore.setState({ activeProjectId: second.id }) }
      useProjectsStore.setState({ managedCatalogStatus: "stock" })
      expect(useProjectsStore.getState().activeProjectId).toBe(second.id)
    } finally { save.mockRestore(); useProjectsStore.getState().resetManagedCatalog() }
  })
  test("a runtime reset discards the held pointer", () => {
    hold()
    useProjectsStore.getState().resetManagedCatalog()
    useProjectsStore.setState({ managedCatalogStatus: "stock" })
    expect(useProjectsStore.getState().activeProjectId).toBe(null)
    useProjectsStore.getState().resetManagedCatalog()
  })
  test("unknown -> unavailable -> stock restores the saved selection without a settings write", () => {
    const save = spyOn(settings, "updateDesktopSettings").mockResolvedValue(undefined)
    try {
      const { first } = hold()
      useProjectsStore.setState({ managedCatalogStatus: "unavailable" })
      expect(useProjectsStore.getState().activeProjectId).toBe(first.id)
      useProjectsStore.setState({ managedCatalogStatus: "stock" })
      expect(useProjectsStore.getState().activeProjectId).toBe(first.id)
      expect(save).not.toHaveBeenCalled()
    } finally { save.mockRestore(); useProjectsStore.getState().resetManagedCatalog() }
  })
})

describe("useProjectsStore selection identity", () => {
  test("changes only the active project id", () => {
    const first = { id: "project-a", path: "/repo-a", lastOpenedAt: 10 } as ProjectEntry
    const second = { id: "project-b", path: "/repo-b", lastOpenedAt: 20 } as ProjectEntry
    const projects = [first, second]
    useProjectsStore.setState({
      projects,
      activeProjectId: first.id,
      manualProjectOrder: projects.map((project) => project.id),
    })

    useProjectsStore.getState().setActiveProjectIdOnly(second.id)

    const state = useProjectsStore.getState()
    expect(state.activeProjectId).toBe(second.id)
    expect(state.projects).toBe(projects)
    expect(state.projects.map((project) => project.lastOpenedAt)).toEqual([10, 20])
  })
})

describe("useProjectsStore default model and thinking level", () => {
  const seed = (project: ProjectEntry) => {
    useProjectsStore.setState({
      projects: [project],
      activeProjectId: project.id,
      manualProjectOrder: [project.id],
    })
  }

  test("keeps a thinking level next to the model it belongs to", () => {
    seed({ id: "project-a", path: "/repo" } as ProjectEntry)

    useProjectsStore.getState().updateProjectMeta("project-a", {
      defaultModel: "anthropic/claude-opus-5",
      defaultVariant: "high",
    })

    const project = useProjectsStore.getState().projects[0]
    expect(project?.defaultModel).toBe("anthropic/claude-opus-5")
    expect(project?.defaultVariant).toBe("high")
  })

  test("drops the thinking level when the model is cleared", () => {
    seed({
      id: "project-a",
      path: "/repo",
      defaultModel: "anthropic/claude-opus-5",
      defaultVariant: "high",
    } as ProjectEntry)

    useProjectsStore.getState().updateProjectMeta("project-a", { defaultModel: null })

    const project = useProjectsStore.getState().projects[0]
    expect(project?.defaultModel).toBe(undefined)
    expect(project?.defaultVariant).toBe(undefined)
  })

  test("ignores a thinking level that arrives without a model", () => {
    useProjectsStore.getState().synchronizeFromSettings({
      projects: [{ id: "project-a", path: "/repo", defaultVariant: "high" }],
    } as DesktopSettings)

    const project = useProjectsStore.getState().projects[0]
    expect(project?.defaultVariant).toBe(undefined)
  })
})

describe("managed catalog default project", () => {
  // Live 2026-09-24: shared settings said smarty-code, but a fresh page opened on the first catalog
  // member because the catalog published before the bootstrap settings sync and that sync was ignored.
  test("a bootstrap settings sync after the catalog selects the shared remembered project", () => {
    const save = spyOn(settings, "updateDesktopSettings").mockResolvedValue(undefined)
    try {
      useProjectsStore.getState().resetManagedCatalog()
      useProjectsStore.setState({ projects: [], activeProjectId: null, manualProjectOrder: [] })
      useProjectsStore.getState().applyManagedCatalog([{ id: "g-org", worktree: "/p/dev" }, { id: "g-code", worktree: "/p/code" }])
      const [org, code] = useProjectsStore.getState().managedProjects!
      expect(useProjectsStore.getState().activeProjectId).toBe(org!.id)
      useProjectsStore.getState().synchronizeFromSettings({ projects: [], activeProjectId: code!.id } as DesktopSettings, { adoptActiveProject: true })
      expect(useProjectsStore.getState().activeProjectId).toBe(code!.id)
      expect(useDirectoryStore.getState().currentDirectory).toBe("/p/code")
      // A later reconcile sync (another window's choice) does not move this window.
      useProjectsStore.getState().synchronizeFromSettings({ projects: [], activeProjectId: org!.id } as DesktopSettings, { adoptActiveProject: false })
      expect(useProjectsStore.getState().activeProjectId).toBe(code!.id)
    } finally {
      save.mockRestore()
      useProjectsStore.getState().resetManagedCatalog()
    }
  })
})

describe("managed catalog remembered directory", () => {
  // R3.4 gate: shared lastDirectory named the smarty-dev checkout, but the stale active pointer selected smarty-code.
  test("a bootstrap sync prefers the remembered directory over a stale active pointer", () => {
    const save = spyOn(settings, "updateDesktopSettings").mockResolvedValue(undefined)
    try {
      useProjectsStore.getState().resetManagedCatalog()
      useProjectsStore.setState({ projects: [], activeProjectId: null, manualProjectOrder: [] })
      useProjectsStore.getState().applyManagedCatalog([{ id: "g-dev", worktree: "/p/dev" }, { id: "g-code", worktree: "/p/code" }])
      const [dev, code] = useProjectsStore.getState().managedProjects!
      useProjectsStore.getState().synchronizeFromSettings({ projects: [], activeProjectId: code!.id, lastDirectory: "/p/dev" } as DesktopSettings, { adoptActiveProject: true })
      expect(useProjectsStore.getState().activeProjectId).toBe(dev!.id)
    } finally {
      save.mockRestore()
      useProjectsStore.getState().resetManagedCatalog()
    }
  })
  test("first admission (admit, then apply) selects the project at the locally remembered directory", () => {
    const storage = getDeferredSafeStorage()
    const previous = storage.getItem("lastDirectory")
    try {
      useProjectsStore.getState().resetManagedCatalog()
      useProjectsStore.setState({ projects: [], activeProjectId: "stale", manualProjectOrder: [] })
      storage.setItem("lastDirectory", "/p/dev/")
      useProjectsStore.getState().admitManagedCatalog()
      useProjectsStore.getState().applyManagedCatalog([{ id: "g-code", worktree: "/p/code" }, { id: "g-dev", worktree: "/p/dev" }])
      const dev = useProjectsStore.getState().managedProjects!.find(project => project.path === "/p/dev")
      expect(useProjectsStore.getState().activeProjectId).toBe(dev!.id)
    } finally {
      if (previous === null) storage.removeItem("lastDirectory"); else storage.setItem("lastDirectory", previous)
      useProjectsStore.getState().resetManagedCatalog()
    }
  })
})

describe("useProjectsStore.addProjects", () => {
  const resetProjects = () => {
    // Add requires an affirmatively stock catalog (#126 item 8).
    useProjectsStore.setState({
      projects: [],
      activeProjectId: null,
      manualProjectOrder: [],
      managedCatalogStatus: "stock",
    })
  }

  test("adding and selecting captures the project list before the addition", async () => {
    const save = spyOn(settings, "updateDesktopSettings").mockResolvedValue(undefined)
    try {
      resetProjects()
      await useProjectsStore.getState().addProject("/one")
      const first = save.mock.calls.find(([changes]) => changes.projects)
      expect(first?.[1]?.expectedProjects).toEqual([])
      const callsBefore = save.mock.calls.length
      await useProjectsStore.getState().addProjects(["/two", "/three"])
      const second = save.mock.calls.slice(callsBefore).find(([changes]) => changes.projects)
      expect(second?.[1]?.expectedProjects?.map((project: ProjectEntry) => project.path)).toEqual(["/one"])
    } finally {
      save.mockRestore()
    }
  })

  test("adds multiple new projects in one update and activates the first", async () => {
    resetProjects()

    const added = await useProjectsStore.getState().addProjects(["/one", "/two", "/three"])

    expect(added).toHaveLength(3)
    expect(useProjectsStore.getState().projects.map((p) => p.path)).toEqual(["/one", "/two", "/three"])
    expect(useProjectsStore.getState().activeProjectId).toBe(added[0].id)
    expect(added[0].addedAt).toBe(added[1].addedAt)
  })

  test("skips already-added paths and duplicates within the batch", async () => {
    resetProjects()
    await useProjectsStore.getState().addProjects(["/one"])

    const added = await useProjectsStore.getState().addProjects(["/one", "/two", "/two", "/one"])

    expect(added).toHaveLength(1)
    expect(added[0].path).toBe("/two")
    expect(useProjectsStore.getState().projects.map((p) => p.path)).toEqual(["/one", "/two"])
  })

  test("skips invalid paths and returns an empty array when nothing is addable", async () => {
    resetProjects()

    const added = await useProjectsStore.getState().addProjects(["", "   ", 42 as unknown as string])

    expect(added).toEqual([])
    expect(useProjectsStore.getState().projects).toEqual([])
  })

  test("normalizes paths (trailing separators, backslashes, tilde expansion)", async () => {
    resetProjects()

    const added = await useProjectsStore.getState().addProjects(["/repo/", "C:\\repo", "~/project"])

    const home = useDirectoryStore.getState().homeDirectory;
    expect(added.map((p) => p.path)).toEqual(["/repo", "C:/repo", home ? `${home}/project` : "~/project"])
  })
})

describe("project icon discovery across a runtime switch", () => {
  test("a late discovery response never replaces the new runtime's project list (smarty-code#155)", async () => {
    const { switchRuntimeEndpoint } = await import("@/lib/runtime-switch")
    const runtimeB = { id: "project-b", path: "/runtime-b" } as ProjectEntry
    let respond: (response: Response) => void = () => {}
    const fetched = spyOn(globalThis, "fetch").mockImplementation(
      (() => new Promise<Response>((resolve) => { respond = resolve })) as unknown as typeof fetch)
    try {
      useProjectsStore.setState({ projects: [runtimeB], activeProjectId: runtimeB.id })
      const discovery = useProjectsStore.getState().discoverProjectIcon("project-a")
      for (let tick = 0; tick < 5; tick++) await Promise.resolve()
      // Headers arrive on runtime A; the switch happens while the body (A's settings) is still being read.
      let body: ReadableStreamDefaultController<Uint8Array> | undefined
      respond(new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller } }),
        { headers: { "content-type": "application/json" } }))
      for (let tick = 0; tick < 20; tick++) await Promise.resolve()
      switchRuntimeEndpoint({ apiBaseUrl: "http://runtime-b.invalid" })
      body!.enqueue(new TextEncoder().encode(JSON.stringify({ settings: { projects: [{ path: "/runtime-a" }] } })))
      body!.close()
      expect(await discovery).toEqual({ ok: false, error: "Runtime request is stale" })
      expect(useProjectsStore.getState().projects).toEqual([runtimeB])
    } finally {
      fetched.mockRestore()
    }
  })
})
