import { expect, test } from 'bun:test'
import { createOpencodeClient } from '@opencode-ai/sdk/v2'
import { ChildStoreManager } from './child-store'
import { SessionMessageLoader } from './session-message-loader'
import { deferred } from '../lib/runtime-isolation-fixture'
import { record, target } from './session-message-loader-replace.fixture'

type HeldResponse = { release: () => void; promise: Promise<void>; started: boolean }

// OC#473: use the real SDK request serializer and real child store. Hold a complete
// old response, not a mutable branch reference, so its late delivery remains H1.
function setup() {
  const children = new ChildStoreManager()
  const g = { epoch: 'P', history: 'H1', prefix: 'm', offset: 1 }
  const reads: Array<{ method: string; path: string; directory: string | null; at: number; limit: number; epoch: string | null; history: string }> = []
  const gates: Array<ReturnType<typeof hold>> = []
  const pending: Array<ReturnType<typeof hold>> = []
  const loads: Promise<void>[] = []
  function hold(): HeldResponse {
    const release = deferred<void>()
    const gate = { release: () => release.resolve(), promise: release.promise, started: false }
    gates.push(gate)
    pending.push(gate)
    return gate
  }
  const client = () => createOpencodeClient({ baseUrl: 'https://header-dedup.invalid', fetch: async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (request.method !== 'GET' || url.pathname !== `/session/${target.sessionID}/message`) {
      throw new Error(`Unexpected SDK request: ${request.method} ${url.pathname}`)
    }
    const at = Number(url.searchParams.get('at'))
    const limit = Number(url.searchParams.get('limit'))
    reads.push({ method: request.method, path: url.pathname, directory: url.searchParams.get('directory'),
      at, limit, epoch: url.searchParams.get('epoch'), history: g.history })
    const start = at < 0 ? Math.max(0, 100 + at) : at
    const data = Array.from({ length: Math.min(limit, 100 - start) }, (_, i) => {
      const row = record(`${g.prefix}${String(g.offset + start + i).padStart(5, '0')}`)
      return { ...row, parts: row.parts.map(part => ({ ...part, text: `${g.history}:${row.info.id}` })) }
    })
    const response = Response.json(data, { headers: { 'x-smarty-at': String(start), 'x-smarty-total': '100',
      'x-smarty-index-epoch': g.epoch, 'x-smarty-history-epoch': g.history } })
    const gate = at >= 0 ? pending.shift() : undefined
    if (gate) { gate.started = true; await gate.promise }
    return response
  } })
  const loader = new SessionMessageLoader(children, { sdk: client(), runtimeKey: 'header-dedup-runtime' })
  const track = (load: Promise<void>) => { loads.push(load); return load }
  const shown = () => (children.getChild(target.directory)?.getState().message[target.sessionID] ?? []).map(m => m.id)
  const body = () => shown().flatMap(id => children.getChild(target.directory)?.getState().part[id] ?? [])
    .flatMap(part => part.type === 'text' ? [part.text] : [])
  const rewrite = (epoch = 'P') => { Object.assign(g, { epoch, history: 'H2', prefix: 'r', offset: 101 }) }
  const done = async () => {
    loader.dispose()
    for (const gate of gates) gate.release()
    await Promise.allSettled(loads)
    children.disposeAll()
    await flush()
  }
  return { children, loader, reads, hold, track, shown, body, rewrite, client, done }
}

// The SDK dispatches and decodes through promise continuations. This is a bounded
// microtask drain, with no polling timer, service or network request.
async function flush() { for (let i = 0; i < 100; i++) await Promise.resolve() }

function checkOpen(initial: ReturnType<SessionMessageLoader['getSnapshot']>, reads: ReturnType<typeof setup>['reads']) {
  expect(initial.status).toBe('ready')
  expect(initial.positions).toEqual({ total: 100, epoch: 'P', historyEpoch: 'H1', ranges: [{ start: 50, end: 100 }] })
  expect(reads[0]).toMatchObject({ method: 'GET', path: `/session/${target.sessionID}/message`,
    directory: target.directory, at: -50, limit: 50, epoch: null, history: 'H1' })
  expect(reads[1]).toMatchObject({ at: 0, limit: 2, epoch: 'P', history: 'H1' })
}

test('healthy P/H1 tail refresh preserves the same window dedup owner', async () => {
  const s = setup()
  const observed = await (async () => {
    try {
      await s.track(s.loader.ensure(target, { reason: 'navigation' }))
      const initial = s.loader.getSnapshot(target), gate = s.hold()
      const old = s.track(s.loader.loadAt(target, 0, 2))
      await flush()
      const duplicate = s.track(s.loader.loadAt(target, 0, 2))
      await s.track(s.loader.refreshTail(target, 5))
      const afterTail = s.track(s.loader.loadAt(target, 0, 2))
      gate.release(); await old
      return { initial, started: gate.started, shared: old === duplicate && old === afterTail,
        reads: [...s.reads], shown: s.shown(), body: s.body() }
    } finally { await s.done() }
  })()
  checkOpen(observed.initial, observed.reads)
  expect(observed.started).toBe(true)
  expect(observed.shared).toBe(true)
  expect(observed.reads).toHaveLength(3)
  expect(observed.shown.slice(0, 2)).toEqual(['m00001', 'm00002'])
  expect(observed.body).toContain('H1:m00001')
})

test('a genuine index reset fences the held window and permits another read of its key', async () => {
  const s = setup()
  const observed = await (async () => {
    try {
      await s.track(s.loader.ensure(target, { reason: 'navigation' }))
      const initial = s.loader.getSnapshot(target), gate = s.hold()
      const old = s.track(s.loader.loadAt(target, 0, 2))
      await flush(); s.rewrite('Q')
      s.loader.noteIndex(target, 100, 'Q', 'H2')
      await s.track(s.loader.refreshTail(target, 100))
      gate.release(); await old
      const before = s.shown(), fresh = s.track(s.loader.loadAt(target, 0, 2))
      await fresh
      return { initial, started: gate.started, before, shown: s.shown(), fresh: fresh !== old, reads: [...s.reads] }
    } finally { await s.done() }
  })()
  checkOpen(observed.initial, observed.reads)
  expect(observed.started).toBe(true)
  expect(observed.before.every(id => id.startsWith('r'))).toBe(true)
  expect(observed.fresh).toBe(true)
  expect(observed.reads.at(-1)).toMatchObject({ at: 0, limit: 2, epoch: 'Q', history: 'H2' })
  expect(observed.shown).toContain('r00101')
})

for (const change of ['sdk', 'store', 'disposal']) {
  test(`${change} replacement rejects a late window without publishing its body`, async () => {
    const s = setup()
    const observed = await (async () => {
      try {
        await s.track(s.loader.ensure(target, { reason: 'navigation' }))
        const initial = s.loader.getSnapshot(target), gate = s.hold()
        const old = s.track(s.loader.loadAt(target, 0, 2))
        await flush()
        let replaced = true
        if (change === 'sdk') s.loader.configure({ sdk: s.client(), runtimeKey: 'header-dedup-runtime' })
        if (change === 'store') {
          replaced = s.children.disposeDirectory(target.directory)
          s.children.ensureChild(target.directory, { bootstrap: false })
        }
        if (change === 'disposal') s.loader.dispose()
        const before = s.shown(), body = s.body()
        gate.release(); await old
        return { initial, started: gate.started, replaced, before, body, shown: s.shown(), after: s.body(), reads: [...s.reads] }
      } finally { await s.done() }
    })()
    checkOpen(observed.initial, observed.reads)
    expect(observed.started).toBe(true)
    expect(observed.replaced).toBe(true)
    expect(observed.reads).toHaveLength(2)
    expect(observed.shown).toEqual(observed.before)
    expect(observed.after).toEqual(observed.body)
    expect(observed.shown).not.toContain('m00001')
  })
}

for (const epoch of ['P', 'Q']) {
  test(`header-discovered H2 with positional epoch ${epoch} replaces stale same-key dedup and protects its fresh owner`, async () => {
    const s = setup()
    const observed = await (async () => {
      try {
        await s.track(s.loader.ensure(target, { reason: 'navigation' }))
        const initial = s.loader.getSnapshot(target), oldGate = s.hold()
        const old = s.track(s.loader.loadAt(target, 0, 2))
        await flush()
        s.rewrite(epoch)
        // This is the MERGE tail path. No noteIndex event grants H2 authority.
        await s.track(s.loader.refreshTail(target, 5))
        const rewritten = s.loader.getSnapshot(target), tailBody = s.body()
        const freshGate = s.hold(), fresh = s.track(s.loader.loadAt(target, 0, 2))
        await flush()
        const readsBeforeOld = s.reads.length
        oldGate.release(); await old
        const afterOld = s.body(), owner = s.track(s.loader.loadAt(target, 0, 2))
        await flush()
        const readsAfterOld = s.reads.length
        freshGate.release(); await Promise.all([fresh, owner])
        return { initial, rewritten, tailBody, afterOld, body: s.body(), oldStarted: oldGate.started,
          freshStarted: freshGate.started, distinct: fresh !== old, ownerShared: owner === fresh,
          readsBeforeOld, readsAfterOld, reads: [...s.reads], shown: s.shown() }
      } finally { await s.done() }
    })()
    checkOpen(observed.initial, observed.reads)
    expect(observed.oldStarted).toBe(true)
    expect(observed.rewritten.status).toBe('ready')
    expect(observed.rewritten.positions).toEqual({ total: 100, epoch, historyEpoch: 'H2', ranges: [{ start: 95, end: 100 }] })
    expect(observed.tailBody).toEqual(['H2:r00196', 'H2:r00197', 'H2:r00198', 'H2:r00199', 'H2:r00200'])
    expect(observed.afterOld).toEqual(observed.tailBody)
    // Evidence is emitted only after every response, load and store has drained.
    console.info('header-rewrite-dedup observation', JSON.stringify({ epoch, ...observed }))
    expect(observed.readsBeforeOld).toBe(4)
    expect(observed.freshStarted).toBe(true)
    expect(observed.distinct).toBe(true)
    expect(observed.ownerShared).toBe(true)
    expect(observed.readsAfterOld).toBe(4)
    expect(observed.reads[3]).toMatchObject({ at: 0, limit: 2, epoch, history: 'H2' })
    expect(observed.shown.slice(0, 2)).toEqual(['r00101', 'r00102'])
    expect(observed.body.slice(0, 2)).toEqual(['H2:r00101', 'H2:r00102'])
    expect(observed.body.some(text => text.startsWith('H1:'))).toBe(false)
  })
}
