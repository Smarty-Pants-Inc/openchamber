import assert from 'node:assert/strict';
import { test } from 'vitest';
import { WebSocket } from 'ws';
import { fixture, paths, failures, saw, waitFor } from './human-member-fixture.js';

for (const path of paths) {
  test(`${path}: active members keep streaming and client close releases readers`, async () => {
    const f = await fixture();
    try {
      const clients = [];
      for (const session of f.sessions) clients.push(await f.connect(path, session));
      const emitters = [...clients.map(client => client.socket), f.changes];
      assert.deepEqual(clients.map(client => client.result), [101, 101, 101]);
      await waitFor(() => clients.every(client => client.frames.some(frame => frame.type === 'ready')), emitters, 'all ready');
      f.emit('first'); await waitFor(() => clients.every(client => saw(client, 'first')), emitters, 'all active members receive');
      f.emit('second'); await waitFor(() => clients.every(client => saw(client, 'second')), emitters, 'active streams continue');
      assert.equal(f.effects.upstream, path === paths[0] ? 1 : 3);
      clients[0].socket.close();
      await waitFor(() => f.runtime.wsServer.clients.size === 2 && f.streams.size === (path === paths[0] ? 1 : 2),
        emitters, 'client close removes only its reader');
      f.emit('peer'); await waitFor(() => clients.slice(1).every(client => saw(client, 'peer')), emitters, 'peers stay live');
      for (const client of clients.slice(1)) client.socket.close();
      await waitFor(() => f.runtime.wsServer.clients.size === 0 && f.streams.size === 0 && f.wsClients.size === 0,
        emitters, 'last client close releases all readers');
      assert.equal(f.effects.closed, f.effects.upstream);
    } finally { await f.close(); }
  });

  for (const failure of failures) test(`${path}: ${failure} closes all old member bindings within deadline`, async () => {
    const f = await fixture();
    try {
      const clients = [];
      for (const session of f.sessions) clients.push(await f.connect(path, session));
      const emitters = [...clients.map(client => client.socket), f.changes];
      assert.deepEqual(clients.map(client => client.result), [101, 101, 101]);
      await waitFor(() => clients.every(client => client.frames.some(frame => frame.type === 'ready')), emitters, 'all ready');
      f.emit('before'); await waitFor(() => clients.every(client => saw(client, 'before')), emitters, 'baseline private delivery');
      assert.equal(f.effects.processed, path === paths[0] ? 1 : 3);
      await f.withdraw(failure);
      const registryFailed = ['malformed', 'unreadable'].includes(failure);
      const ended = registryFailed ? clients : clients.slice(0, 2);
      const healthy = registryFailed ? [] : clients.slice(2);
      try {
        await waitFor(() => ended.every(client => client.socket.readyState === WebSocket.CLOSED), emitters,
          'withdrawn member sockets retained beyond 2500ms');
      } catch (error) {
        // Publish only AFTER the allowed detection window, including on RED.
        f.emit('after-deadline');
        await waitFor(() => clients.some(client => saw(client, 'after-deadline')), emitters, 'RED delivery witness', 500);
        assert.fail(`${error.message}; private delivery after deadline = ${ended.some(client => saw(client, 'after-deadline'))}`);
      }
      const remainingReaders = registryFailed ? 0 : 1;
      await waitFor(() => f.runtime.wsServer.clients.size === healthy.length && f.streams.size === remainingReaders,
        emitters, 'withdrawal removes clients and only affected readers');
      assert.equal(f.wsClients.size, path === paths[0] ? healthy.length : 0);
      assert.equal(f.effects.upstream, path === paths[0] ? 1 : 3, 'withdrawal never restarts upstream');
      assert.equal(f.effects.closed, registryFailed ? f.effects.upstream : path === paths[0] ? 0 : 2);
      const frameCounts = ended.map(client => client.frames.length);
      f.emit('after');
      if (healthy.length) {
        await waitFor(() => healthy.every(client => saw(client, 'after')), emitters, 'unrelated active member still receives');
        assert.equal(healthy[0].socket.readyState, WebSocket.OPEN);
      }
      assert.deepEqual(ended.map(client => client.frames.length), frameCounts, 'no later private frames after closure');
      assert.equal(f.database.prepare('SELECT count(*) AS count FROM session').get().count, 3, 'no auth session deletion');
      if (failure !== 'mapping-rebound') {
        assert.equal(await f.human.resolve({ headers: Object.fromEntries(f.sessions[0].headers) }), null);
        assert.equal((await f.connect(path, f.sessions[0])).result, 401, 'fresh admission fails closed');
      } else {
        const rebound = await f.human.resolve({ headers: Object.fromEntries(f.sessions[0].headers) });
        assert.equal(f.human.actor(rebound, { forwarded: true }).member.smartyId, 'sp-other', 'old binding is not current authority');
      }
      for (const client of healthy) client.socket.close();
      await waitFor(() => f.streams.size === 0 && f.runtime.wsServer.clients.size === 0 && f.wsClients.size === 0,
        emitters, 'healthy final close releases hub or directory reader');
      assert.equal(f.effects.closed, f.effects.upstream);
    } finally { await f.close(); }
  });
}
