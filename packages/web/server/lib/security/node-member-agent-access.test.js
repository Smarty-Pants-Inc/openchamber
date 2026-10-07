import { createServer } from 'node:http';
import express from 'express';
import { afterEach, expect, it } from 'vitest';
import { fixture } from '../ui-auth/human-member-fixture.js';
import { createUiAuth } from '../ui-auth/ui-auth.js';
import { refuseMemberAgentActions } from './node-member-agent-access.js';
import { memberInitiated, runMemberRequestsInScope } from './node-member-execution.js';

/** The real human auth gate (a Node member, or a human with no Node), then the read-only gate as the server mounts it
 *  on /api, then a stand-in for everything behind it (the OpenCode proxy and OpenChamber's own agent routes). */
const closers = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });

const serve = async (mode) => {
  const f = await fixture({ configured: mode === 'member' });
  const app = express(), server = createServer(app), agent = [];
  const controller = createUiAuth({ humanAuth: f.human });
  app.get('/auth/session', controller.handleSessionStatus);
  app.use('/api', controller.requireAuth);
  app.use('/api', refuseMemberAgentActions);
  app.use('/api', runMemberRequestsInScope);
  // Whether Git started by this request would be locked down: after body parsing and an await, as a route sees it.
  app.post('/api/scope', express.json(), async (req, res) => {
    await new Promise(done => setTimeout(done, 1));
    res.json({ member: memberInitiated({ SMARTY_CODE_NODE_ID: 'fixture-node' }) });
  });
  app.use('/api', (req, res) => { agent.push(`${req.method} ${req.originalUrl}`); res.json({ ok: true }); });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  closers.push(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); await f.close(); });
  const headers = Object.fromEntries(f.headers);
  const send = async (method, path) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method,
      headers: { ...headers, 'content-type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });
    return { status: response.status, body: await response.json() };
  };
  return { agent, send, readOnly: async () => (await send('GET', '/auth/session')).body.agentReadOnly };
};

const REFUSAL = { error: 'members can view this agent; prompting needs isolation, #1442', code: 'NODE_MEMBER_AGENT_READ_ONLY' };
const agentActions = [
  ['POST', '/api/session/s1/message'], ['POST', '/api/session/s1/prompt_async'], ['POST', '/api/session/s1/command'],
  ['POST', '/api/session/s1/shell'], ['POST', '/api/session/s1/abort'], ['POST', '/api/session'],
  ['POST', '/api/permission/p1/reply'], ['POST', '/api/session/s1/permissions/p1'], ['POST', '/api/question/q1/reply'],
  ['POST', '/api/tui/submit-prompt'], ['POST', '/api/message-queue/sessions/s1/items'], ['PUT', '/api/goals/objective/s1'],
  ['POST', '/api/openchamber/control'], ['POST', '/api/openchamber/sessions/s1/send'],
  ['PUT', '/api/permission-auto-accept/sessions/s1'], ['POST', '/api/projects/p1/scheduled-tasks/t1/run'],
  // Spellings the upstream router would still read as a session prompt.
  ['POST', '/api//session/s1/message'], ['POST', '/api/%73ession/s1/prompt_async'], ['POST', '/api/x/../session/s1/abort'],
  ['POST', '/api/Session/s1/message'],
];

it('Node member: every prompt, command, shell, abort or approval is refused and the agent gets nothing', async () => {
  const { agent, send } = await serve('member');
  for (const [method, path] of agentActions) expect([path, await send(method, path)]).toEqual([path, { status: 403, body: REFUSAL }]);
  expect(agent).toEqual([]);
});

it('Node member: viewing sessions still reaches the agent', async () => {
  const { agent, send } = await serve('member');
  for (const path of ['/api/session', '/api/session/s1/message', '/api/event']) expect((await send('GET', path)).status).toBe(200);
  expect((await send('POST', '/api/sessions/s1/view')).status).toBe(200); // viewing state, not the agent
  expect(agent).toEqual(['GET /api/session', 'GET /api/session/s1/message', 'GET /api/event', 'POST /api/sessions/s1/view']);
});

it('owner (human, no Node): prompts are unchanged', async () => {
  const { agent, send } = await serve('human');
  for (const [method, path] of agentActions.slice(0, 5)) expect((await send(method, path)).status).toBe(200);
  expect(agent).toHaveLength(5);
});

it('the session status tells the UI to hide the composer for a Node member only', async () => {
  expect(await (await serve('member')).readOnly()).toBe(true);
  expect(await (await serve('human')).readOnly()).toBe(false);
});

it('a Node member request runs in the member Git scope; an owner request does not', async () => {
  expect((await (await serve('member')).send('POST', '/api/scope')).body).toEqual({ member: true });
  expect((await (await serve('human')).send('POST', '/api/scope')).body).toEqual({ member: false });
});
