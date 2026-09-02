import { describe, expect, test } from 'bun:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { createOpencodeClient } from '@opencode-ai/sdk/v2'
import { SyncProvider, useSyncDirectory, createProjectCatalogInvalidationRefresh } from './sync-context'
import { usePrefetchSessionMessages } from './use-sync'
import { installHookTestDom } from '../components/session/sidebar/test-utils/testDom'
import { useProjectsStore } from '../stores/useProjectsStore'
import { useGlobalSyncStore } from './global-sync-store'

const createSdk = (projectList?: () => Promise<unknown[]>) => createOpencodeClient({
  baseUrl: 'https://sync.test',
  fetch: async (request) => {
    const path = new URL(request instanceof Request ? request.url : request.toString()).pathname
    if (path.endsWith('/global/event')) {
      return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } })
    }
    const body = path.endsWith('/path')
      ? { state: '', config: '', worktree: '/workspace', directory: '/workspace', home: '/home' }
      : path.endsWith('/project') ? await (projectList?.() ?? Promise.resolve([]))
      : path.endsWith('/project/current') ? { id: 'project' }
      : path.endsWith('/session/status') ? {}
      : []
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
  },
})

describe('SyncProvider selection boundary', () => {
  test('does not rerender a stable prefetch consumer when only current directory changes', async () => {
    const dom = installHookTestDom()
    const root = createRoot(dom.container)
    let runtimeRenders = 0
    let directoryRenders = 0
    let callback: ReturnType<typeof usePrefetchSessionMessages> | undefined
    const RuntimeConsumer = React.memo(() => {
      callback = usePrefetchSessionMessages()
      runtimeRenders += 1
      return null
    })
    const DirectoryConsumer = () => {
      useSyncDirectory()
      directoryRenders += 1
      return null
    }
    const sdk = createSdk()

    try {
      await act(async () => root.render(
        <SyncProvider sdk={sdk} directory="/workspace/a">
          <RuntimeConsumer />
          <DirectoryConsumer />
        </SyncProvider>,
      ))
      const initialCallback = callback
      await act(async () => root.render(
        <SyncProvider sdk={sdk} directory="/workspace/b">
          <RuntimeConsumer />
          <DirectoryConsumer />
        </SyncProvider>,
      ))
      expect(runtimeRenders).toBe(1)
      expect(callback).toBe(initialCallback)
      expect(directoryRenders).toBe(2)
    } finally {
      await act(async () => root.unmount())
      dom.restore()
    }
  })

  test('drops a catalog response that finishes after a same-runtime provider remount', async () => {
    const dom = installHookTestDom()
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(JSON.stringify({ runtime: 'smarty-oc' }), {
      headers: { 'content-type': 'application/json' },
    })
    useGlobalSyncStore.getState().actions.reset()
    useProjectsStore.setState({
      projects: [],
      presentationProjects: [],
      runtimeProjectMembershipActive: false,
      activeProjectId: null,
      manualProjectOrder: [],
    })

    let resolveFirst!: (projects: unknown[]) => void
    let resolveSecond!: (projects: unknown[]) => void
    let firstStarted!: () => void
    let secondStarted!: () => void
    const firstProjects = new Promise<unknown[]>((resolve) => {
      resolveFirst = resolve
    })
    const secondProjects = new Promise<unknown[]>((resolve) => {
      resolveSecond = resolve
    })
    const firstCatalogStarted = new Promise<void>((resolve) => {
      firstStarted = resolve
    })
    const secondCatalogStarted = new Promise<void>((resolve) => {
      secondStarted = resolve
    })
    const firstSdk = createSdk(async () => {
      firstStarted()
      return firstProjects
    })
    const secondSdk = createSdk(async () => {
      secondStarted()
      return secondProjects
    })
    let root = createRoot(dom.container)

    try {
      await act(async () => root.render(
        <React.StrictMode>
          <SyncProvider sdk={firstSdk} directory="">
            <div />
          </SyncProvider>
        </React.StrictMode>,
      ))
      await firstCatalogStarted
      await act(async () => root.unmount())

      root = createRoot(dom.container)
      await act(async () => root.render(
        <React.StrictMode>
          <SyncProvider sdk={secondSdk} directory="">
            <div />
          </SyncProvider>
        </React.StrictMode>,
      ))
      await secondCatalogStarted

      await act(async () => {
        resolveSecond([{ id: 'second', worktree: '/second' }])
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(useGlobalSyncStore.getState().projects.map((project) => project.id)).toEqual(['second'])

      await act(async () => {
        resolveFirst([{ id: 'first', worktree: '/first' }])
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(useGlobalSyncStore.getState().projects.map((project) => project.id)).toEqual(['second'])
    } finally {
      await act(async () => root.unmount())
      useGlobalSyncStore.getState().actions.reset()
      globalThis.fetch = originalFetch
      dom.restore()
    }
  })

  test('coalesces transient catalog invalidations and clears the completed request', async () => {
    let calls = 0
    const refresh = createProjectCatalogInvalidationRefresh(
      async () => {
        calls += 1
        if (calls === 1) throw new Error('project.list failed (503)')
      },
      () => true,
      () => true,
    )

    const first = refresh()
    expect(refresh()).toBe(first)
    await first
    // attempt 1 (503) + coalesced invalidation advancing the tracker + retry attempt
    expect(calls).toBe(3)

    await refresh()
    expect(calls).toBe(4)
  })

  test('advances the catalog refresh tracker when an invalidation lands mid-flight', async () => {
    let calls = 0
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const refresh = createProjectCatalogInvalidationRefresh(
      async () => {
        calls += 1
        if (calls === 1) await firstGate
      },
      () => true,
      () => true,
    )

    const first = refresh()
    expect(calls).toBe(1)

    const coalesced = refresh()
    expect(coalesced).toBe(first)
    // The underlying refresh is re-invoked so the in-flight snapshot re-reads
    // instead of committing a catalog captured before this event.
    expect(calls).toBe(2)

    releaseFirst()
    await first
    expect(calls).toBe(2)

    await refresh()
    expect(calls).toBe(3)
  })

  test('clears a rejected invalidation so a reconnect can refresh again', async () => {
    let connected = false
    let calls = 0
    const refresh = createProjectCatalogInvalidationRefresh(
      async () => {
        calls += 1
      },
      () => true,
      () => connected,
    )

    await expect(refresh()).rejects.toThrow('no longer current')
    connected = true
    await refresh()
    expect(calls).toBe(1)
  })
})
