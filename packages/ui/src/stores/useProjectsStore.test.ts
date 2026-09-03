import { beforeEach, describe, expect, test } from "bun:test"
import type { ProjectEntry } from "@/lib/api/types"
import type { DesktopSettings } from "@/lib/desktop"
import { useProjectsStore } from "./useProjectsStore"

beforeEach(() => {
  useProjectsStore.setState({
    projects: [],
    presentationProjects: [],
    runtimeProjectMembershipActive: false,
    activeProjectId: null,
    manualProjectOrder: [],
  })
})

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

  test("preserves projects when a nonempty settings list has no valid entries", () => {
    const project = { id: "project-a", path: "/repo", label: "Repo" } as ProjectEntry
    useProjectsStore.setState({ projects: [project], presentationProjects: [project], activeProjectId: project.id })

    useProjectsStore.getState().synchronizeFromSettings({
      projects: [{ path: "" }, null],
    } as DesktopSettings)

    expect(useProjectsStore.getState().projects).toEqual([project])
    expect(useProjectsStore.getState().presentationProjects).toEqual([project])
  })


  test("applies valid projects while dropping malformed entries", () => {
    useProjectsStore.getState().synchronizeFromSettings({
      projects: [{ path: "/valid" }, { path: "" }, null],
    } as DesktopSettings)

    expect(useProjectsStore.getState().projects.map((project) => project.path)).toEqual(["/valid"])
  })
  test("a reconcile sync never adopts another window's active project", () => {
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

describe("useProjectsStore runtime project catalog authority", () => {
  test("keeps ordinary runtime project membership settings-owned", () => {
    const settingsProject: ProjectEntry = { id: "settings-a", path: "/settings-a", label: "Settings A" }
    useProjectsStore.setState({
      projects: [settingsProject],
      presentationProjects: [settingsProject],
      activeProjectId: settingsProject.id,
      manualProjectOrder: [settingsProject.id],
    })

    useProjectsStore.getState().synchronizeFromRuntimeProjects([{ worktree: "/runtime-only" }])

    expect(useProjectsStore.getState().runtimeProjectMembershipActive).toBe(false)
    expect(useProjectsStore.getState().projects.map((project) => project.path)).toEqual(["/settings-a"])

    const added = useProjectsStore.getState().addProject("/settings-b")
    expect(added?.path).toBe("/settings-b")
    useProjectsStore.getState().removeProject(settingsProject.id)
    expect(useProjectsStore.getState().projects.map((project) => project.path)).toEqual(["/settings-b"])
  })

  test("uses a live gateway catalog for membership while preserving metadata across reconnects", () => {
    useProjectsStore.getState().synchronizeFromSettings({
      projects: [{ id: "configured-a", path: "/repo-a", label: "Configured A" }],
    })
    const configuredA = useProjectsStore.getState().projects[0]
    if (!configuredA) throw new Error("settings project was not created")

    useProjectsStore.getState().synchronizeFromRuntimeProjects([
      { worktree: "/repo-a" },
      { worktree: "/repo-b" },
    ], { liveCatalog: true })

    const runtimeB = useProjectsStore.getState().projects.find((project) => project.path === "/repo-b")
    expect(configuredA).toBeDefined()
    expect(runtimeB).toBeDefined()
    expect(useProjectsStore.getState().runtimeProjectMembershipActive).toBe(true)
    expect(useProjectsStore.getState().addProject("/settings-only")).toBeNull()
    useProjectsStore.getState().removeProject(configuredA.id)
    expect(useProjectsStore.getState().projects.map((project) => project.path).sort()).toEqual(["/repo-a", "/repo-b"])

    useProjectsStore.getState().synchronizeFromSettings({
      projects: [{ id: "configured-b", path: "/repo-b", label: "Gateway B" }],
    })
    expect(useProjectsStore.getState().projects.map((project) => project.path).sort()).toEqual(["/repo-a", "/repo-b"])

    useProjectsStore.getState().synchronizeFromRuntimeProjects([
      { worktree: "/repo-b" },
      { worktree: "/repo-c" },
    ], { liveCatalog: true })
    expect(useProjectsStore.getState().projects.map((project) => project.path)).toEqual(["/repo-b", "/repo-c"])
    expect(useProjectsStore.getState().projects[0]?.label).toBe("Gateway B")
    useProjectsStore.getState().synchronizeFromRuntimeProjects([{ worktree: "/repo-b" }], { liveCatalog: true })
    const reconnected = useProjectsStore.getState().projects[0]
    expect(reconnected?.path).toBe("/repo-b")
    expect(reconnected?.label).toBe("Gateway B")
  })

  test("adopts a valid bootstrap active project without restoring settings-only projects", () => {
    const settings: DesktopSettings = {
      projects: [
        { id: "configured-a", path: "/repo-a" },
        { id: "configured-b", path: "/repo-b" },
        { id: "settings-only", path: "/settings-only" },
      ],
    }
    useProjectsStore.getState().synchronizeFromSettings(settings)
    const [first, second, settingsOnly] = useProjectsStore.getState().projects
    if (!first || !second || !settingsOnly) throw new Error("settings projects were not created")

    useProjectsStore.getState().synchronizeFromRuntimeProjects([
      { worktree: first.path },
      { worktree: second.path },
    ], { liveCatalog: true })
    useProjectsStore.setState({ activeProjectId: first.id })

    useProjectsStore.getState().synchronizeFromSettings({
      ...settings,
      activeProjectId: second.id,
    })

    const state = useProjectsStore.getState()
    expect(state.activeProjectId).toBe(second.id)
    expect(state.projects.map((project) => project.path)).toEqual(["/repo-a", "/repo-b"])
    expect(state.projects.some((project) => project.id === settingsOnly.id)).toBe(false)
  })

  test("keeps live-only projects out of presentation settings until an icon action needs them", () => {
    const settings: DesktopSettings = {
      projects: [{ id: "settings-project", path: "/settings-project" }],
    }
    useProjectsStore.getState().synchronizeFromSettings(settings)

    useProjectsStore.getState().synchronizeFromRuntimeProjects([
      { worktree: "/gateway-project" },
    ], { liveCatalog: true })

    const state = useProjectsStore.getState()
    expect(state.projects.map((project) => project.path)).toEqual(["/gateway-project"])
    expect(state.presentationProjects.map((project) => project.path)).toEqual(["/settings-project"])
  })

  test("releases live membership only after an explicit non-gateway identity", () => {
    const settings: DesktopSettings = {
      projects: [{ id: "settings-project", path: "/settings-project" }],
    }
    useProjectsStore.getState().synchronizeFromSettings(settings)
    useProjectsStore.getState().synchronizeFromRuntimeProjects([
      { worktree: "/gateway-project" },
    ], { liveCatalog: true })

    useProjectsStore.getState().synchronizeFromRuntimeProjects([], {})
    expect(useProjectsStore.getState().runtimeProjectMembershipActive).toBe(true)

    useProjectsStore.getState().synchronizeFromRuntimeProjects([], { liveCatalog: false })
    expect(useProjectsStore.getState().runtimeProjectMembershipActive).toBe(false)
    expect(useProjectsStore.getState().addProject("/settings-added")?.path).toBe("/settings-added")
  })
})
