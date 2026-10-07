import { createServer } from 'node:http';
import express from 'express';
import { afterEach, expect, it } from 'vitest';
import { fixture } from '../ui-auth/human-member-fixture.js';
import { createUiAuth } from '../ui-auth/ui-auth.js';
import { memberAllowList } from './node-member-agent-access.js';
import { memberInitiated, runMemberRequestsInScope } from './node-member-execution.js';

/** The member allow-list as the server mounts it (first, before every route), then the real human auth gate (a Node
 *  member, or a human with no Node), the member scope, and a stand-in for every route behind them. */
const closers = [];
const savedNodeId = process.env.SMARTY_CODE_NODE_ID;
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  if (savedNodeId === undefined) delete process.env.SMARTY_CODE_NODE_ID; else process.env.SMARTY_CODE_NODE_ID = savedNodeId;
});

const serve = async (mode) => {
  const f = await fixture({ configured: mode === 'member' });
  if (mode === 'member') process.env.SMARTY_CODE_NODE_ID = 'test-node'; else delete process.env.SMARTY_CODE_NODE_ID;
  const app = express(), server = createServer(app), reached = [];
  const controller = createUiAuth({ humanAuth: f.human });
  app.use(memberAllowList);
  app.get('/auth/session', controller.handleSessionStatus);
  // As in the server: the agent's tool route is registered before the human gate and checks its own token.
  app.post('/api/openchamber/agent-tool', (req, res) => { reached.push(`${req.method} ${req.originalUrl}`); res.json({ ok: true }); });
  app.use('/api', controller.requireAuth);
  app.use('/api', runMemberRequestsInScope);
  // Whether Git started by this request would be locked down: after body parsing and an await, as a route sees it.
  app.get('/api/git/status', express.json(), async (req, res) => {
    await new Promise(done => setTimeout(done, 1));
    reached.push(`${req.method} ${req.originalUrl}`);
    res.json({ member: memberInitiated({ SMARTY_CODE_NODE_ID: 'test-node' }) });
  });
  app.use((req, res) => { reached.push(`${req.method} ${req.originalUrl}`); res.json({ ok: true }); });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  closers.push(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); await f.close(); });
  const headers = Object.fromEntries(f.headers);
  const send = async (method, path, extra = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method,
      headers: { ...headers, 'content-type': 'application/json', ...extra }, body: ['GET', 'HEAD'].includes(method) ? undefined : '{}' });
    return { status: response.status, body: method === 'HEAD' ? null : await response.json() };
  };
  return { reached, send };
};

const REFUSAL = { error: 'members have read-only access until isolation, smarty-code#1442', code: 'NODE_MEMBER_READ_ONLY' };
const denied = [
  // Agent actions (decision A).
  ['POST', '/api/session/s1/message'], ['POST', '/api/session/s1/prompt_async'], ['POST', '/api/session/s1/command'],
  ['POST', '/api/session/s1/shell'], ['POST', '/api/session/s1/abort'], ['POST', '/api/session'],
  ['POST', '/api/permission/p1/reply'], ['POST', '/api/question/q1/reply'], ['POST', '/api/tui/submit-prompt'],
  ['POST', '/api/message-queue/sessions/s1/items'], ['PUT', '/api/goals/objective/s1'], ['POST', '/api/openchamber/control'],
  ['POST', '/api/openchamber/sessions/s1/send'], ['PUT', '/api/permission-auto-accept/sessions/s1'],
  ['POST', '/api/projects/p1/scheduled-tasks/t1/run'],
  // Round 15: agent tools without the agent's bearer, terminal force-kill and DELETE, writes, Git mutation.
  ['POST', '/api/openchamber/agent-tool'], ['POST', '/api/terminal/force-kill'], ['DELETE', '/api/terminal/t1'],
  ['POST', '/api/terminal/create'], ['POST', '/api/fs/write'], ['POST', '/api/fs/clone'], ['POST', '/api/git/commit'],
  ['POST', '/api/git/worktrees'], ['PUT', '/api/config/settings'],
  // Reads that are not views: owner settings, identities, credentials.
  ['GET', '/api/config/settings'], ['GET', '/api/git/discover-credentials'], ['GET', '/api/git/identities'],
  // Round 15 half A: fs and Git reads trust a caller-chosen directory (e.g. /proc/<pid>/environ), so members get none
  // until a member-authorized root exists; the voice socket path is not a view.
  ['GET', '/api/fs/read?path=/proc/1/environ&directory=/proc/1'], ['GET', '/api/fs/list?path=/proc'],
  ['GET', '/api/fs/raw?path=/etc/passwd'], ['GET', '/api/git/diff?directory=/r'], ['GET', '/api/git/log?directory=/r'],
  ['GET', '/api/git/commit-files?directory=/r&hash=HEAD'], ['GET', '/api/session/s1/voice/socket'],
  // Spellings a router might read differently, and paths outside /api that change state.
  ['POST', '/api//session/s1/message'], ['POST', '/api/%73ession/s1/prompt_async'], ['POST', '/api/x/../session/s1/abort'],
  ['POST', '/API/fs/write'], ['GET', '/api/fs/read/../../config/settings'], ['GET', '/api/%66s/read'],
  ['POST', '/auth/session'],
];

it('Node member: everything off the read-only allow-list is refused and reaches no route', async () => {
  const { reached, send } = await serve('member');
  for (const [method, path] of denied) expect([method, path, await send(method, path)]).toEqual([method, path, { status: 403, body: REFUSAL }]);
  expect(reached).toEqual([]);
});

it('Node member: session views and event streams still reach their routes', async () => {
  const { reached, send } = await serve('member');
  for (const path of ['/api/session', '/api/session/s1', '/api/session/s1/message', '/api/session/s1/message/m1',
    '/api/session/s1/children', '/api/event', '/api/global/event', '/api/sessions/status']) {
    expect([path, (await send('GET', path)).status]).toEqual([path, 200]);
  }
  expect((await send('POST', '/api/sessions/s1/view')).status).toBe(200); // the attention mark, not the agent
  expect(reached).toHaveLength(9);
});

it('Node mode: the agent reaches its tool route with its bearer (the route checks the token)', async () => {
  const { reached, send } = await serve('member');
  expect((await send('POST', '/api/openchamber/agent-tool', { authorization: 'Bearer agent-token' })).status).not.toBe(403);
  expect(reached).toEqual(['POST /api/openchamber/agent-tool']);
});

it('owner (human, no Node): writes and prompts are unchanged, outside the member scope', async () => {
  const { reached, send } = await serve('human');
  for (const [method, path] of denied.slice(0, 24)) expect([path, (await send(method, path)).status]).toEqual([path, 200]);
  expect((await send('GET', '/api/fs/read?path=a')).status).toBe(200);
  expect((await send('GET', '/api/git/status?directory=/r')).body).toEqual({ member: false });
  expect(reached).toHaveLength(26);
});

it('the session status tells the UI to hide the composer for a Node member only', async () => {
  expect((await (await serve('member')).send('GET', '/auth/session')).body.agentReadOnly).toBe(true);
  expect((await (await serve('human')).send('GET', '/auth/session')).body.agentReadOnly).toBe(false);
});

/** Raw WebSocket upgrades bypass Express. In Node mode the shared upgrade gate refuses every upgrade except the event
 *  streams, before host, origin or session checks and before any upstream connection. */
it('Node mode: only event-stream upgrades pass the shared upgrade gate', async () => {
  const f = await fixture({ configured: true });
  closers.push(() => f.close());
  process.env.SMARTY_CODE_NODE_ID = 'test-node';
  const controller = createUiAuth({ humanAuth: f.human });
  const upgrade = path => new Promise((resolve) => {
    const req = { url: path, headers: { host: 'nowhere.invalid' }, socket: {} };
    controller.requireUpgradeAuth(req, {}, () => resolve('next'), (_socket, status, message) => resolve(`${status} ${message}`));
  });
  for (const path of ['/api/session/s1/voice/socket', '/api/terminal/ws', '/api/dictation/ws', '/api/dev-tunnel',
    '/api/openchamber/realtime-proxy/ws?url=x', '/api/session//s1/voice/socket']) {
    expect([path, await upgrade(path)]).toEqual([path, '403 members have read-only access until isolation, smarty-code#1442']);
  }
  // Event streams go on to the normal checks (here: the host check refuses the fixture host, not the member gate).
  for (const path of ['/api/event/ws', '/api/global/event/ws?directory=/r']) {
    expect(await upgrade(path)).not.toMatch(/read-only access/);
  }
});
