import { describe, expect, test } from "bun:test"
import { buildSessionBootstrapDemands } from "./sessionBootstrapDemands"

describe("buildSessionBootstrapDemands", () => {
  test("demands only the current directory and the selected session directory", () => {
    const demands = buildSessionBootstrapDemands({
      currentDirectory: "/repo",
      currentSessionDirectory: "/repo/wt-b",
    })

    expect(demands).toEqual([
      { directory: "/repo", priority: "selected", reason: "current-directory" },
      { directory: "/repo/wt-b", priority: "selected", reason: "selected-session" },
    ])
  })

  // Managed G13 previously initialized ~86 fleet directories. Topology still
  // contains them, but only the two directories being worked in are demand.
  test("a managed fleet never bootstraps every known or expanded project", () => {
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
    expect(buildSessionBootstrapDemands(input).map(({ directory, priority }) => [directory, priority]))
      .toEqual([["/fleet/p3", "selected"], ["/fleet/p7/wt", "selected"]])
  })

  test("deduplicates one directory selected through both paths", () => {
    const demands = buildSessionBootstrapDemands({
      currentDirectory: "/repo/",
      currentSessionDirectory: "/repo",
    })

    expect(demands.map(({ directory, reason }) => [directory, reason])).toEqual([["/repo", "current-directory"]])
  })

  test("publishes nothing without a working directory", () => {
    expect(buildSessionBootstrapDemands({ currentDirectory: null, currentSessionDirectory: null })).toEqual([])
  })
})
