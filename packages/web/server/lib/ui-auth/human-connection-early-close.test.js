import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'vitest';
import { once } from 'node:events';
import { earlyCloseFixture } from './human-connection-early-close-fixture.js';

for (const kind of ['http', 'upgrade']) {
  test(`${kind}: first real auth lookup completes after delivered peer close without lifetime retention`, async () => {
    const f = await earlyCloseFixture();
    try {
      const { client } = await f.connect(kind);
      await f.sampled.promise;
      assert.equal(f.transport.destroyed, false);
      if (kind === 'upgrade') client.resetAndDestroy(); else client.destroy();
      await f.closed.promise;
      assert.equal(f.transport.destroyed, true, 'server-side close delivered before releasing first lookup');
      const baseline = { close: f.transport.listenerCount('close'), finish: f.transport.listenerCount('finish') };
      f.release.resolve();
      await f.settled.promise;
      const reads = f.accountReads;
      await sleep(1100);
      const observed = { downstream: f.downstream, connection: Boolean(f.req.humanConnection),
        closeListeners: f.transport.listenerCount('close') - baseline.close,
        finishListeners: f.transport.listenerCount('finish') - baseline.finish,
        expiry: f.timers.expiry.size, watchers: f.timers.watchers.size,
        sweepAccountReads: f.accountReads - reads };
      console.log(`${kind} initial-close lifecycle`, observed);
      assert.deepEqual(observed, { downstream: 0, connection: false, closeListeners: 0,
        finishListeners: 0, expiry: 0, watchers: 0, sweepAccountReads: 0 });
    } finally { await f.close(); }
  }, 10000);

  test(`${kind}: close during second real lookup retires registered lifetime`, async () => {
    const f = await earlyCloseFixture({ lookup: 2 });
    try {
      const { client } = await f.connect(kind);
      await f.sampled.promise;
      assert.equal(f.timers.expiry.size, 1);
      assert.equal(f.timers.watchers.size, 1);
      if (kind === 'upgrade') client.resetAndDestroy(); else client.destroy();
      await f.closed.promise;
      f.release.resolve(); await f.settled.promise;
      assert.equal(f.downstream, 0);
      assert.equal(f.req.humanConnection, undefined);
      assert.equal(f.timers.expiry.size, 0);
      assert.equal(f.timers.watchers.size, 0);
      assert.equal(f.transport.listenerCount('finish'), f.baseline.finish);
    } finally { await f.close(); }
  }, 10000);

  test(`${kind}: failed second lookup refuses and retires allocated lifetime`, async () => {
    const f = await earlyCloseFixture({ lookup: 2, failLookup: true });
    try {
      const { client } = await f.connect(kind);
      await f.sampled.promise;
      assert.equal(f.timers.expiry.size, 1);
      f.release.resolve(); await f.settled.promise; await f.closed.promise;
      assert.equal(f.downstream, 0);
      assert.equal(f.req.humanConnection, undefined);
      assert.equal(f.timers.expiry.size, 0);
      assert.equal(f.timers.watchers.size, 0);
      client.destroy();
    } finally { await f.close(); }
  }, 10000);

  for (const configured of [true, false]) test(`${kind}: healthy ${configured ? 'Node member' : 'legacy human'} admission retains real authority`, async () => {
    const f = await earlyCloseFixture({ configured });
    try {
      const { result } = await f.connect(kind);
      await f.sampled.promise; f.release.resolve(); await f.settled.promise;
      assert.equal(await result, kind === 'http' ? 200 : 101);
      assert.equal(f.downstream, 1);
      assert.ok(f.req.humanConnection);
      await f.closed.promise;
      assert.equal(await f.req.humanConnection.authorize(), false);
      assert.equal(f.timers.expiry.size, 0);
      assert.equal(f.timers.watchers.size, 0);
    } finally { await f.close(); }
  }, 10000);
}

for (const earlyEnding of ['ended', 'destroyed']) test(`HTTP response already ${earlyEnding} before authentication cannot acquire lifetime state`, async () => {
  const f = await earlyCloseFixture({ earlyEnding });
  try {
    await f.connect('http'); await f.sampled.promise; await f.closed.promise;
    assert.ok(f.transport.destroyed || f.transport.writableEnded);
    const baseline = { close: f.transport.listenerCount('close'), finish: f.transport.listenerCount('finish') };
    f.release.resolve(); await f.settled.promise;
    assert.equal(f.downstream, 0);
    assert.equal(f.req.humanConnection, undefined);
    assert.equal(f.transport.listenerCount('close'), baseline.close);
    assert.equal(f.transport.listenerCount('finish'), baseline.finish);
    assert.equal(f.timers.expiry.size, 0);
    assert.equal(f.timers.watchers.size, 0);
  } finally { await f.close(); }
}, 10000);

test('last live HTTP entry stops the Node watcher without closing an unrelated active member', async () => {
  const f = await earlyCloseFixture({ lookup: 0 });
  try {
    const headers = await f.unrelatedHeaders();
    const first = await f.connect('http', { live: true });
    assert.equal(await first.result, 200);
    const firstResponse = f.transport, firstRequest = f.req;
    const other = await f.connect('http', { live: true, headers });
    assert.equal(await other.result, 200);
    const otherResponse = f.transport, otherRequest = f.req;
    assert.equal(f.timers.expiry.size, 2);
    assert.equal(f.timers.watchers.size, 1);
    const firstClosed = once(firstResponse, 'close'); first.client.destroy(); await firstClosed;
    assert.equal(await firstRequest.humanConnection.authorize(), false);
    assert.equal(otherResponse.destroyed, false);
    assert.equal(await otherRequest.humanConnection.authorize(), true);
    assert.equal(f.timers.expiry.size, 1);
    assert.equal(f.timers.watchers.size, 1);
    const otherClosed = once(otherResponse, 'close'); other.client.destroy(); await otherClosed;
    assert.equal(f.timers.expiry.size, 0);
    assert.equal(f.timers.watchers.size, 0);
    const reads = f.accountReads; await sleep(1100);
    assert.equal(f.accountReads, reads, 'no membership adapter work after last live entry');
  } finally { await f.close(); }
}, 10000);
