import assert from 'node:assert/strict';
import { test } from 'vitest';
import { fixture, failures, saw, waitFor } from '../event-stream/human-member-fixture.js';

const ready = client => client.frames.some(frame => frame.type === 'openchamber:event-stream-ready');

test('HTTP protect: active member SSE continues and client close cleans subscription', async () => {
  const f = await fixture();
  try {
    const clients = [];
    for (const session of f.sessions) clients.push(await f.connectSse(session));
    const emitters = clients.map(client => client.socket);
    assert.deepEqual(clients.map(client => client.result), [200, 200, 200]);
    await waitFor(() => clients.every(ready), emitters, 'actual scheduled-task SSE route ready');
    f.emit('first'); await waitFor(() => clients.every(client => saw(client, 'first')), emitters, 'active members receive');
    f.emit('second'); await waitFor(() => clients.every(client => saw(client, 'second')), emitters, 'active SSE continues');
    clients[0].socket.destroy();
    await waitFor(() => f.sseClients.size === 2, [f.changes, ...emitters], 'client close removes subscription');
    f.emit('peer'); await waitFor(() => clients.slice(1).every(client => saw(client, 'peer')), emitters, 'peer SSE healthy');
    for (const client of clients.slice(1)) client.socket.destroy();
    await waitFor(() => f.sseClients.size === 0, [f.changes, ...emitters], 'last SSE close cleans subscriptions');
  } finally { await f.close(); }
});

for (const failure of failures) test(`HTTP protect: ${failure} ends existing member SSE within deadline`, async () => {
  const f = await fixture();
  try {
    const clients = [];
    for (const session of f.sessions) clients.push(await f.connectSse(session));
    const emitters = clients.map(client => client.socket);
    assert.deepEqual(clients.map(client => client.result), [200, 200, 200]);
    await waitFor(() => clients.every(ready), emitters, 'actual SSE ready');
    f.emit('before'); await waitFor(() => clients.every(client => saw(client, 'before')), emitters, 'private baseline delivery');
    await f.withdraw(failure);
    const registryFailed = ['malformed', 'unreadable'].includes(failure);
    const ended = registryFailed ? clients : clients.slice(0, 2);
    const healthy = registryFailed ? [] : clients.slice(2);
    try {
      await waitFor(() => ended.every(client => client.socket.destroyed), emitters, 'member SSE retained beyond 2500ms');
    } catch (error) {
      f.emit('after-deadline');
      await waitFor(() => clients.some(client => saw(client, 'after-deadline')), emitters, 'RED private SSE witness', 500);
      assert.fail(`${error.message}; private delivery after deadline = ${ended.some(client => saw(client, 'after-deadline'))}`);
    }
    await waitFor(() => f.sseClients.size === healthy.length, [f.changes, ...emitters], 'withdrawal cleans SSE subscriptions');
    const frameCounts = ended.map(client => client.frames.length);
    f.emit('after');
    if (healthy.length) {
      await waitFor(() => healthy.every(client => saw(client, 'after')), emitters, 'unrelated member SSE stays live');
      assert.equal(healthy[0].socket.destroyed, false);
    }
    assert.deepEqual(ended.map(client => client.frames.length), frameCounts, 'no private SSE frames after closure');
    assert.equal(f.database.prepare('SELECT count(*) AS count FROM session').get().count, 3, 'auth sessions preserved');
    if (failure !== 'mapping-rebound') {
      const refused = await f.connectSse(f.sessions[0]);
      assert.equal(refused.result, 401, 'HTTP fresh admission fails closed');
      refused.socket.resume();
    }
    for (const client of healthy) client.socket.destroy();
    await waitFor(() => f.sseClients.size === 0, [f.changes, ...emitters], 'healthy client close releases final subscription');
  } finally { await f.close(); }
});
