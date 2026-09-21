import { describe, expect, test } from 'bun:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { createOpencodeClient } from '@opencode-ai/sdk/v2'
import { SyncProvider, useSyncDirectory, useDirectoryStore, useSessions, useSessionStatus, useSyncRuntime } from './sync-context'
import { usePwaManifestSync } from '../hooks/usePwaManifestSync'
import { usePrefetchSessionMessages } from './use-sync'
import { installHookTestDom } from '../components/session/sidebar/test-utils/testDom'

const createSdk = () => createOpencodeClient({
  baseUrl: 'https://sync.test',
  fetch: async (request) => {
    const path = new URL(request instanceof Request ? request.url : request.toString()).pathname
    if (path.endsWith('/global/event')) {
      return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } })
    }
    const body = path.endsWith('/path')
      ? { state: '', config: '', worktree: '/workspace', directory: '/workspace', home: '/home' }
      : path.endsWith('/project') ? []
      : path.endsWith('/project/current') ? { id: 'project' }
      : path.endsWith('/session/status') ? {}
      : []
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
  },
})

describe('SyncProvider selection boundary', () => {
  test('cold empty selection stays inert and transitions to a real directory without losing retained stores', async () => {
    const dom = installHookTestDom()
    const root = createRoot(dom.container)
    const sdk = createSdk()
    let observed: ReturnType<typeof useDirectoryStore> | undefined
    let system: ReturnType<typeof useSyncRuntime> | undefined
    let visible = ''
    const Consumer = () => {
      system = useSyncRuntime()
      observed = useDirectoryStore(undefined, { bootstrap: false })
      usePwaManifestSync() // The actual unconditional SyncAppEffects caller from the deployed crash.
      const sessions = useSessions()
      const status = useSessionStatus('')
      visible = `${sessions.length}:${status?.type ?? 'none'}`
      return null
    }
    const render = (directory: string) => act(async () => root.render(
      <SyncProvider sdk={sdk} directory={directory}><Consumer /></SyncProvider>,
    ))
    try {
      await render('')
      expect(visible).toBe('0:none')
      expect(system!.childStores.children.size).toBe(0)
      expect(() => system!.childStores.ensureChild('')).toThrow('No directory')
      const empty = observed!
      expect(() => empty.getState().patch({ status: 'complete' })).toThrow('No directory')
      await render('/workspace/a')
      expect(observed).not.toBe(empty)
      const selected = observed!
      await render('')
      expect(observed).toBe(empty)
      expect(system!.childStores.getChild('/workspace/a')).toBe(selected)
      expect(system!.childStores.children.has('')).toBe(false)
      await render('/workspace/a')
      expect(observed).toBe(selected)
    } finally {
      await act(async () => root.unmount())
      dom.restore()
    }
  })

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
})
