import { describe, expect, spyOn, test } from "bun:test"
import type { CreateGitWorktreePayload, GitAPI, GitStatus, GitWorktreeCreateResult } from "./api/types"
import {
  canMutateWorktrees,
  createGitWorktree,
  deleteGitWorktree,
  getGitStatus,
  previewGitWorktree,
  validateGitWorktree,
  WorktreeMutationUnavailableError,
} from "./gitApi"

const status: GitStatus = {
  current: "main",
  tracking: null,
  ahead: 0,
  behind: 0,
  files: [],
  isClean: true,
}

const withRuntimeGit = async (git: Partial<GitAPI>, callback: () => Promise<void>) => {
  const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      __OPENCHAMBER_RUNTIME_APIS__: { git },
    },
  })

  try {
    await callback()
  } finally {
    if (previousWindowDescriptor) {
      Object.defineProperty(globalThis, "window", previousWindowDescriptor)
    } else {
      delete (globalThis as { window?: Window }).window
    }
  }
}

describe("getGitStatus", () => {
  test("forwards light-mode options to runtime git APIs", async () => {
    let received: { directory: string; options?: { mode?: "light" } } | null = null
    const runtimeGit: Partial<GitAPI> = {
      getGitStatus: async (directory: string, options?: { mode?: "light" }) => {
        received = { directory, options }
        return status
      },
    }

    await withRuntimeGit(runtimeGit, async () => {
      await getGitStatus("/repo", { mode: "light" })
    })

    expect(received).toEqual({ directory: "/repo", options: { mode: "light" } })
  })
})

const createPayload: CreateGitWorktreePayload = { mode: "new", worktreeName: "feature" }

const created: GitWorktreeCreateResult = {
  head: "abc123",
  name: "feature",
  branch: "feature",
  path: "/repo-worktrees/feature",
}

// runtimeFetch reaches the server through globalThis.fetch, so a fetch spy
// observes any HTTP worktree call.
const withFetchSpy = async (callback: (calls: () => number) => Promise<void>) => {
  const fetchSpy = spyOn(globalThis, "fetch")
  try {
    await callback(() => fetchSpy.mock.calls.length)
  } finally {
    fetchSpy.mockRestore()
  }
}

describe("worktree mutations", () => {
  test("refuse without a runtime bridge and never reach the HTTP server", async () => {
    await withFetchSpy(async (fetchCalls) => {
      const runtimeGit: Partial<GitAPI> = {}
      await withRuntimeGit(runtimeGit, async () => {
        expect(canMutateWorktrees()).toBe(false)
        await expect(validateGitWorktree("/repo", createPayload)).rejects.toBeInstanceOf(WorktreeMutationUnavailableError)
        await expect(previewGitWorktree("/repo", createPayload)).rejects.toBeInstanceOf(WorktreeMutationUnavailableError)
        await expect(createGitWorktree("/repo", createPayload)).rejects.toBeInstanceOf(WorktreeMutationUnavailableError)
        await expect(deleteGitWorktree("/repo", { directory: "/repo-worktrees/feature" })).rejects.toBeInstanceOf(WorktreeMutationUnavailableError)
      })
      expect(fetchCalls()).toBe(0)
    })
  })

  test("delegate to the runtime worktree bridge when it is present", async () => {
    const received: string[] = []
    const runtimeGit: Partial<GitAPI> = {
      worktree: {
        list: async () => [],
        create: async (directory: string) => {
          received.push(`create:${directory}`)
          return created
        },
        remove: async (directory: string) => {
          received.push(`remove:${directory}`)
          return { success: true }
        },
      },
    }

    await withFetchSpy(async (fetchCalls) => {
      await withRuntimeGit(runtimeGit, async () => {
        expect(canMutateWorktrees()).toBe(true)
        expect(await createGitWorktree("/repo", createPayload)).toEqual(created)
        expect(await deleteGitWorktree("/repo", { directory: "/repo-worktrees/feature" })).toEqual({ success: true })
      })
      expect(fetchCalls()).toBe(0)
    })
    expect(received).toEqual(["create:/repo", "remove:/repo"])
  })
})
