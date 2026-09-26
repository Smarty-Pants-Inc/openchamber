import type { DirectoryBootstrapDemand, DirectoryBootstrapPriority } from "@/sync/child-store"
import { normalizePath } from "../utils"

type BootstrapProjectSection = {
  project: { id: string; normalizedPath: string }
  groups: Array<{
    id: string
    directory: string | null
    isArchivedBucket?: boolean
    isMain: boolean
  }>
}

const PRIORITY_RANK = {
  selected: 0,
  "active-project": 1,
  expanded: 2,
  visible: 3,
  background: 4,
} satisfies Record<DirectoryBootstrapPriority, number>

export function buildSessionBootstrapDemands(input: {
  projectSections?: BootstrapProjectSection[]
  knownDirectories?: Iterable<string>
  activeProjectDirectory?: string | null
  activeProjectId: string | null
  collapsedProjects: ReadonlySet<string>
  collapsedGroups: ReadonlySet<string>
  currentDirectory: string | null
  currentSessionDirectory: string | null
  /**
   * A managed catalog (Smarty Code, G13): the sidebar's rows and statuses come from the catalog's one unscoped session
   * and status reads, so only the selected and active project bootstrap (config, MCP, LSP, commands, session lists).
   * Another project bootstraps when it is selected. Stock bootstraps every known and expanded directory as before.
   * ponytail: its pending OpenCode questions and permissions are not read at load either. A managed gateway answers
   * both with [] (Pi asks in its terminal; all 86 reads in the release-3.25 G13 HAR were []). Revisit if it forwards them.
   * Completions and errors in another project still alert (sync-context notifySessionOutcome).
   */
  managed?: boolean
}): DirectoryBootstrapDemand[] {
  const byDirectory = new Map<string, DirectoryBootstrapDemand>()
  const add = (
    directory: string | null | undefined,
    priority: DirectoryBootstrapPriority,
    reason: DirectoryBootstrapDemand["reason"],
  ) => {
    const normalizedDirectory = normalizePath(directory ?? null)
    if (!normalizedDirectory) return
    const existing = byDirectory.get(normalizedDirectory)
    if (existing && PRIORITY_RANK[existing.priority] <= PRIORITY_RANK[priority]) return
    byDirectory.set(normalizedDirectory, { directory: normalizedDirectory, priority, reason })
  }

  for (const directory of input.knownDirectories ?? []) {
    add(directory, "background", "known-project")
  }
  add(input.activeProjectDirectory, "active-project", "project-expanded")

  for (const section of input.projectSections ?? []) {
    const projectExpanded = !input.collapsedProjects.has(section.project.id)
    let projectPriority: DirectoryBootstrapPriority = "background"
    if (section.project.id === input.activeProjectId) {
      projectPriority = "active-project"
    } else if (projectExpanded) {
      projectPriority = "expanded"
    }
    add(
      section.project.normalizedPath,
      projectPriority,
      projectExpanded ? "project-expanded" : "known-project",
    )

    for (const group of section.groups) {
      if (!group.directory || group.isArchivedBucket || group.isMain) continue
      const groupExpanded = projectExpanded && !input.collapsedGroups.has(`${section.project.id}:${group.id}`)
      let groupPriority: DirectoryBootstrapPriority = "background"
      if (groupExpanded) {
        groupPriority = "expanded"
      } else if (projectExpanded) {
        groupPriority = "visible"
      }
      add(
        group.directory,
        groupPriority,
        groupExpanded ? "worktree-expanded" : "known-worktree",
      )
    }
  }

  add(input.currentDirectory, "selected", "current-directory")
  add(input.currentSessionDirectory, "selected", "selected-session")
  const demands = [...byDirectory.values()]
  return input.managed ? demands.filter((demand) => PRIORITY_RANK[demand.priority] <= PRIORITY_RANK["active-project"]) : demands
}
