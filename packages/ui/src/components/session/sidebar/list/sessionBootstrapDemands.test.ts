import { describe, expect, test } from "bun:test"
import { buildSessionBootstrapDemands } from "./sessionBootstrapDemands"

const sections = [{
  project: { id: "project-a", normalizedPath: "/repo" },
  groups: [
    { id: "root", directory: "/repo", isMain: true },
    { id: "worktree:/repo/wt-a", directory: "/repo/wt-a", isMain: false },
    { id: "worktree:/repo/wt-b", directory: "/repo/wt-b", isMain: false },
  ],
}]

describe("buildSessionBootstrapDemands", () => {
  test("keeps collapsed worktrees eligible at background priority", () => {
    const demands = buildSessionBootstrapDemands({
      projectSections: sections,
      activeProjectId: null,
      collapsedProjects: new Set(["project-a"]),
      collapsedGroups: new Set(),
      currentDirectory: null,
      currentSessionDirectory: null,
    })

    expect(demands.map(({ directory, priority }) => [directory, priority])).toEqual([
      ["/repo", "background"],
      ["/repo/wt-a", "background"],
      ["/repo/wt-b", "background"],
    ])
  })

  test("promotes expansion and selected session without duplicate directories", () => {
    const demands = buildSessionBootstrapDemands({
      projectSections: sections,
      activeProjectId: "project-a",
      collapsedProjects: new Set(),
      collapsedGroups: new Set(["project-a:worktree:/repo/wt-b"]),
      currentDirectory: "/repo",
      currentSessionDirectory: "/repo/wt-b",
    })
    const byDirectory = new Map(demands.map((demand) => [demand.directory, demand]))

    expect(demands.length).toBe(3)
    expect(byDirectory.get("/repo")?.priority).toBe("selected")
    expect(byDirectory.get("/repo/wt-a")?.priority).toBe("expanded")
    expect(byDirectory.get("/repo/wt-b")?.priority).toBe("selected")
  })

  test("keeps the complete known topology demanded without a visible section projection", () => {
    const demands = buildSessionBootstrapDemands({
      knownDirectories: ["/repo", "/repo/wt-a", "/repo/wt-b"],
      activeProjectDirectory: "/repo",
      activeProjectId: "project-a",
      collapsedProjects: new Set(),
      collapsedGroups: new Set(),
      currentDirectory: null,
      currentSessionDirectory: null,
    })

    expect(demands.map(({ directory, priority }) => [directory, priority])).toEqual([
      ["/repo", "active-project"],
      ["/repo/wt-a", "background"],
      ["/repo/wt-b", "background"],
    ])
  })

  // smarty-code G13: a managed fleet (~43 Herdr projects) bootstrapped every project at load (config, MCP, LSP,
  // commands, session lists: ~1,150 requests in the first minute). Its rows come from the catalog's unscoped reads, so
  // only the selected and active project bootstrap; another project bootstraps when it is selected.
  test("a managed catalog bootstraps only the selected and active project, never every known or expanded one", () => {
    const fleet = Array.from({ length: 43 }, (_, i) => ({ project: { id: `p${i}`, normalizedPath: `/fleet/p${i}` },
      groups: [{ id: "root", directory: `/fleet/p${i}`, isMain: true }, { id: `wt${i}`, directory: `/fleet/p${i}/wt`, isMain: false }] }))
    const input = {
      projectSections: fleet,
      knownDirectories: fleet.map(({ project }) => project.normalizedPath),
      activeProjectDirectory: "/fleet/p3",
      activeProjectId: "p3",
      collapsedProjects: new Set<string>(),
      collapsedGroups: new Set<string>(),
      currentDirectory: "/fleet/p3",
      currentSessionDirectory: "/fleet/p7/wt",
    }
    expect(buildSessionBootstrapDemands({ ...input, managed: true }).map(({ directory, priority }) => [directory, priority]))
      .toEqual([["/fleet/p3", "selected"], ["/fleet/p7/wt", "selected"]])
    expect(buildSessionBootstrapDemands(input).length).toBe(86) // Stock: unchanged, every project and worktree.
  })
})
