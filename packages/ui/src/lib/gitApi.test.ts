import { describe, expect, test } from "bun:test"
import { useConfigStore } from "@/stores/useConfigStore"
import { useSessionUIStore } from "@/sync/session-ui-store"
import { switchRuntimeEndpoint } from "./runtime-switch"
import type { GitAPI, GitStatus } from "./api/types"
import { generateCommitMessage, getGitStatus, stageGitFile, stageGitFiles, unstageGitFile, unstageGitFiles } from "./gitApi"

const status: GitStatus = {
  current: "main",
  tracking: null,
  ahead: 0,
  behind: 0,
  files: [],
  isClean: true,
}

const withRuntimeGit = async (git: GitAPI, callback: () => Promise<void>) => {
  const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      __OPENCHAMBER_RUNTIME_APIS__: { git },
      location: { origin: 'http://git-generation.test', href: 'http://git-generation.test/' },
      dispatchEvent: () => true,
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
    const runtimeGit = {
      getGitStatus: async (directory: string, options?: { mode?: "light" }) => {
        received = { directory, options }
        return status
      },
    } as Partial<GitAPI> as GitAPI

    await withRuntimeGit(runtimeGit, async () => {
      await getGitStatus("/repo", { mode: "light" })
    })

    expect(received).toEqual({ directory: "/repo", options: { mode: "light" } })
  })
})

describe("git session fallback preflight", () => {
  test("cancels fallback before its bound prompt when the runtime switches during authorization", async () => {
    const originalFetch = globalThis.fetch
    const config = useConfigStore.getState()
    const sessionState = useSessionUIStore.getState()
    const requests: string[] = []
    globalThis.fetch = async (input) => {
      const url = input instanceof Request ? input.url : String(input)
      requests.push(url)
      if (url.includes('/api/magic-prompts')) {
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/api/small-model/generate')) {
        return new Response('', { status: 404 })
      }
      if (url.includes('/send-preflight')) {
        switchRuntimeEndpoint({ apiBaseUrl: 'http://runtime-b.test', runtimeKey: 'runtime-b' })
        return new Response(JSON.stringify({ authorized: true }), {
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected request: ${url}`)
    }

    try {
      await withRuntimeGit({
        getGitLog: async () => ({ all: [], latest: null, total: 0 }),
      } as Partial<GitAPI> as GitAPI, async () => {
        switchRuntimeEndpoint({ apiBaseUrl: 'http://runtime-a.test', runtimeKey: 'runtime-a' })
        useConfigStore.setState({ currentProviderId: 'pi', currentModelId: 'model-a' })
        useSessionUIStore.setState({
          currentSessionId: 'session-generation',
          currentSessionDirectory: '/repo',
          newSessionDraft: { draftId: 0, open: false, directoryOverride: null, parentID: null, target: 'chat' },
        })

        await expect(generateCommitMessage('/repo', [])).rejects.toThrow('runtime changed')
      })

      expect(requests.some((url) => url.includes('/send-preflight'))).toBe(true)
      expect(requests.some((url) => url.includes('/session/session-generation/prompt'))).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
      useConfigStore.setState({
        currentProviderId: config.currentProviderId,
        currentModelId: config.currentModelId,
        currentAgentName: config.currentAgentName,
        currentVariant: config.currentVariant,
      })
      useSessionUIStore.setState({
        currentSessionId: sessionState.currentSessionId,
        currentSessionDirectory: sessionState.currentSessionDirectory,
        newSessionDraft: sessionState.newSessionDraft,
      })
      switchRuntimeEndpoint({ apiBaseUrl: 'http://runtime-a.test', runtimeKey: 'runtime-a' })
    }
  })
})

describe("git index mutations", () => {
  test("forwards bulk stage requests to runtime git APIs", async () => {
    let received: { directory: string; paths: string[] } | null = null
    const runtimeGit = {
      stageGitFiles: async (directory: string, paths: string[]) => {
        received = { directory, paths }
      },
    } as Partial<GitAPI> as GitAPI

    await withRuntimeGit(runtimeGit, async () => {
      await stageGitFiles("/repo", ["a.ts", "b.ts"])
    })

    expect(received).toEqual({ directory: "/repo", paths: ["a.ts", "b.ts"] })
  })

  test("forwards bulk unstage requests to runtime git APIs", async () => {
    let received: { directory: string; paths: string[] } | null = null
    const runtimeGit = {
      unstageGitFiles: async (directory: string, paths: string[]) => {
        received = { directory, paths }
      },
    } as Partial<GitAPI> as GitAPI

    await withRuntimeGit(runtimeGit, async () => {
      await unstageGitFiles("/repo", ["a.ts", "b.ts"])
    })

    expect(received).toEqual({ directory: "/repo", paths: ["a.ts", "b.ts"] })
  })

  test("keeps single-file stage wrapper routed to runtime single-file API", async () => {
    let received: { directory: string; path: string } | null = null
    const runtimeGit = {
      stageGitFile: async (directory: string, path: string) => {
        received = { directory, path }
      },
    } as Partial<GitAPI> as GitAPI

    await withRuntimeGit(runtimeGit, async () => {
      await stageGitFile("/repo", "a.ts")
    })

    expect(received).toEqual({ directory: "/repo", path: "a.ts" })
  })

  test("keeps single-file unstage wrapper routed to runtime single-file API", async () => {
    let received: { directory: string; path: string } | null = null
    const runtimeGit = {
      unstageGitFile: async (directory: string, path: string) => {
        received = { directory, path }
      },
    } as Partial<GitAPI> as GitAPI

    await withRuntimeGit(runtimeGit, async () => {
      await unstageGitFile("/repo", "a.ts")
    })

    expect(received).toEqual({ directory: "/repo", path: "a.ts" })
  })
})
