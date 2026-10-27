import { expect, test } from 'bun:test'
import { ChildStoreManager } from './child-store.ts'
import { SessionMessageLoader } from './session-message-loader.ts'
import { fakeMessagesClient, record, target } from './session-message-loader-replace.fixture.ts'

// Paul, 2026-10-27 23:17Z: successful journal-only polls must update an already-open normal timeline.
function fixture(ordinary: boolean) {
  const stores = new ChildStoreManager()
  let fallback = false, ids = ['m0001', 'm0002'], reads = 0
  const loader = new SessionMessageLoader(stores, { runtimeKey: 'freshness', sdk: fakeMessagesClient(async () => {
    reads++
    const headers = new Headers()
    if (fallback) { headers.set('x-smarty-journal-only', '1'); headers.set('x-smarty-journal-at', `1:0:${reads * 100}`) }
    else if (ordinary) headers.set('x-smarty-ordinary-view', 'ov2_' + 'a'.repeat(64))
    return { data: ids.map(record), headers }
  }) })
  return { loader, stores, reads: () => reads,
    fallback: (next: string[]) => { fallback = true; ids = next },
    normal: (next: string[]) => { fallback = false; ids = next },
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
    f.normal(['m0001', 'm0002', 'm0003', 'm0004', 'm0005'])
    await f.loader.refreshTail(target, 50)
    expect(f.shown()).toEqual(['m0001', 'm0002', 'm0003', 'm0004', 'm0005'])
  } finally { f.close() }
})
