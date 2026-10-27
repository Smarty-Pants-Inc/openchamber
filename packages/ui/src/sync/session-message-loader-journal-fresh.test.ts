import { expect, test } from 'bun:test'
import { ChildStoreManager } from './child-store.ts'
import { SessionMessageLoader } from './session-message-loader.ts'
import { fakeMessagesClient, record, target } from './session-message-loader-replace.fixture.ts'

// Paul, 2026-10-27 23:17Z: successful journal-only polls must update an already-open normal timeline.
function fixture(ordinary: boolean) {
  const stores = new ChildStoreManager()
  let fallback = false, ids = ['m0001', 'm0002'], reads = 0
  let page: ReturnType<typeof record>[] | undefined
  const loader = new SessionMessageLoader(stores, { runtimeKey: 'freshness', sdk: fakeMessagesClient(async () => {
    reads++
    const headers = new Headers()
    if (fallback) { headers.set('x-smarty-journal-only', '1'); headers.set('x-smarty-journal-at', `1:0:${reads * 100}`) }
    else if (ordinary) headers.set('x-smarty-ordinary-view', 'ov2_' + 'a'.repeat(64))
    return { data: page ?? ids.map(record), headers }
  }) })
  return { loader, stores, reads: () => reads,
    fallback: (next: string[]) => { fallback = true; ids = next; page = undefined },
    records: (next: ReturnType<typeof record>[]) => { fallback = true; page = next },
    normal: (next: string[]) => { fallback = false; ids = next; page = undefined },
    shown: () => stores.getChild(target.directory)!.getState().message[target.sessionID]!.map(m => m.id),
    close: () => { loader.dispose(); stores.disposeAll() } }
}

for (const ordinary of [false, true]) test(`new journal entries appear after a normal page (ordinary=${ordinary}) without replacing normal parts`, async () => {
  const f = fixture(ordinary)
  try {
    await f.loader.ensure(target, { reason: 'navigation' })
    const store = f.stores.getChild(target.directory)!
    const normalMessage = store.getState().message[target.sessionID]![1]!
    const normalParts = store.getState().part.m0002!
    const coverage = f.loader.getSnapshot(target)
    f.fallback(['m0002', 'm0003'])
    await f.loader.refreshTail(target, 50)
    expect(f.shown()).toEqual(['m0001', 'm0002', 'm0003'])
    expect(store.getState().message[target.sessionID]![1]).toBe(normalMessage)
    expect(store.getState().part.m0002).toBe(normalParts)
    expect(f.loader.getSnapshot(target).cursor).toBe(coverage.cursor)
    expect(f.loader.getSnapshot(target).provisional).not.toBe(true)
    f.fallback(['m0003', 'm0004'])
    await f.loader.refreshTail(target, 50)
    expect(f.shown()).toEqual(['m0001', 'm0002', 'm0003', 'm0004'])
    f.fallback(['m0001', 'm0002'])
    await f.loader.refreshTail(target, 50)
    expect(f.shown()).toEqual(['m0001', 'm0002', 'm0003', 'm0004'])
    f.fallback(['m0004', 'm0005'])
    f.loader.invalidateOrdinaryViews()
    f.loader.connectionRestored()
    await f.loader.ensure(target, { force: true, reason: 'navigation' })
    expect(f.shown()).toEqual(['m0001', 'm0002', 'm0003', 'm0004', 'm0005'])
    expect(f.loader.getSnapshot(target).status).toBe('ready')
    if (ordinary) expect(f.loader.getAcceptedOrdinaryView(target, 'freshness')).toBeUndefined()
    f.normal(['m0001', 'm0002', 'm0003', 'm0004', 'm0005'])
    await f.loader.refreshTail(target, 50)
    expect(f.shown()).toEqual(['m0001', 'm0002', 'm0003', 'm0004', 'm0005'])
  } finally { f.close() }
})

test('journal merge preserves streamed parts, native aliases, and newer live records even against a conflicting fallback', async () => {
  const f = fixture(true)
  try {
    await f.loader.ensure(target, { reason: 'navigation' })
    const store = f.stores.getChild(target.directory)!, current = store.getState()
    const original = current.message[target.sessionID]![1]!
    const alias = { ...original, metadata: { pi: { entryID: 'native-old' } } }
    const streamedParts = [{ id: 'part_m0002', messageID: 'm0002', sessionID: target.sessionID,
      type: 'text' as const, text: 'newer live text' }]
    const orphanParts = [{ id: 'part_m0003', messageID: 'm0003', sessionID: target.sessionID,
      type: 'text' as const, text: 'live part arrived before its message' }]
    store.setState({ message: { ...current.message, [target.sessionID]: [current.message[target.sessionID]![0]!, alias] },
      part: { ...current.part, m0002: streamedParts, m0003: orphanParts } })
    const disguised = record('m9999')
    const nativeAlias = { ...disguised, info: { ...disguised.info, metadata: { pi: { entryID: 'native-old' } } } }
    f.records([record('m0000'), record('m0002'), nativeAlias, record('m0003')])
    await f.loader.refreshTail(target, 50)
    expect(f.shown()).toEqual(['m0001', 'm0002', 'm0003'])
    expect(store.getState().message[target.sessionID]![1]).toBe(alias)
    expect(store.getState().part.m0002).toBe(streamedParts)
    expect(store.getState().part.m9999).toBeUndefined()
    expect(store.getState().part.m0003).toBe(orphanParts)
    f.fallback([])
    await f.loader.refreshTail(target, 50)
    expect(f.shown()).toEqual(['m0001', 'm0002', 'm0003'])
    expect(store.getState().part.m0002).toBe(streamedParts)
  } finally { f.close() }
})
