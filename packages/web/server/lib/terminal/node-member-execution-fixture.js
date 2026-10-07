import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { WebSocket } from 'ws';
import { fixture, config, member } from '../ui-auth/human-member-fixture.js';
import { createUiAuth } from '../ui-auth/ui-auth.js';
import { createRequestSecurityRuntime } from '../security/request-security.js';
import { createTerminalRuntime } from './runtime.js';
import { createTerminalWsControlFrame, readTerminalWsControlFrame } from './terminal-ws-protocol.js';

/** mode: 'member' (Google auth bound to a Node: SMARTY_CODE_NODE_ID), 'human' (Google, no Node) or 'none' (no UI auth). */
export async function executionFixture(mode) {
  const env = mode === 'member' ? { SMARTY_CODE_NODE_ID: member.nodeId } : {};
  const f = mode === 'none' ? null : await fixture({ configured: mode === 'member' });
  const app = express(), server = createServer(app), spawns = [], writes = [], peers = new Set();
  const controller = f ? createUiAuth({ humanAuth: f.human }) : null;
  const security = createRequestSecurityRuntime({ readSettingsFromDiskMigrated: async () => ({ publicOrigin: config.baseURL }) });
  app.use(express.json());
  if (controller) app.use(controller.requireAuth);
  const runtime = createTerminalRuntime({ app, server, fs, path, uiAuthController: controller, ...security, env,
    buildAugmentedPath: () => process.env.PATH || '', searchPathFor: name => `/fixture/${name}`, isExecutable: () => true,
    TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS: 30_000, signalProcess() {}, terminalTerminationGraceMs: 10,
    loadPtyProvider: async () => ({ backend: 'execution-fixture', spawn: async (executable, args) => {
      spawns.push({ executable, args });
      return { pid: 987654323, write: data => writes.push(data), resize() {}, kill() {}, onData() {},
        onExit() { return { dispose() {} }; } };
    } }) });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = f ? Object.fromEntries(f.headers) : {};
  const post = async (route, body = {}) => {
    const response = await fetch(`${base}${route}`, { method: 'POST', signal: AbortSignal.timeout(5000),
      headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const create = (body = {}) => post('/api/terminal/create', { sessionId: 'execution-terminal', cwd: process.cwd(), shell: 'sh', ...body });
  /** Open the terminal socket, attach and write. Resolves { refused } on an HTTP upgrade refusal, else { frames }. */
  const attachAndWrite = data => new Promise((done, fail) => {
    const socket = new WebSocket(`${base.replace('http:', 'ws:')}/api/terminal/ws`, {
      headers: { ...headers, Origin: config.baseURL }, handshakeTimeout: 3000 });
    peers.add(socket); const frames = [];
    socket.on('unexpected-response', (_req, res) => {
      let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => done({ refused: { status: res.statusCode, text } }));
    });
    socket.on('error', error => { if (socket.readyState !== WebSocket.CLOSED) fail(error); });
    socket.on('message', raw => { const frame = readTerminalWsControlFrame(raw); frames.push(frame);
      if (frame?.t === 'error') { done({ frames }); return; }
      if (frame?.t === 'snapshot') {
      socket.send(createTerminalWsControlFrame({ v: 3, s: 'execution-terminal', t: 'write', d: data }));
      setTimeout(() => done({ frames }), 100);
    } });
    socket.once('open', () => socket.send(createTerminalWsControlFrame({ v: 3, s: 'execution-terminal', t: 'attach' })));
  });
  return { spawns, writes, post, create, attachAndWrite,
    close: async () => {
      for (const socket of peers) socket.terminate();
      await runtime.shutdown(); controller?.dispose?.();
      server.closeAllConnections(); await new Promise(done => server.close(done)); await f?.close();
    } };
}
