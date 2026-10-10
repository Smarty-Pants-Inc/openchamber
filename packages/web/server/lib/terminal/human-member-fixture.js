import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { WebSocket } from 'ws';
import { fixture, config } from '../ui-auth/human-member-fixture.js';
import { createUiAuth } from '../ui-auth/ui-auth.js';
import { createRequestSecurityRuntime } from '../security/request-security.js';
import { createTerminalRuntime } from './runtime.js';
import { createTerminalWsControlFrame, readTerminalWsControlFrame } from './terminal-ws-protocol.js';

export function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

export async function terminalFixture(options) {
  const f = await fixture(options), app = express(), server = createServer(app);
  const writes = [], peers = new Set();
  let killed = 0, output;
  const pty = { write: data => writes.push(data), resize() {}, kill() { killed++; },
    onData(callback) { output = callback; }, onExit() { return { dispose() {} }; } };
  const controller = createUiAuth({ humanAuth: f.human });
  const security = createRequestSecurityRuntime({ readSettingsFromDiskMigrated: async () => ({ publicOrigin: config.baseURL }) });
  app.use(express.json()); app.use(controller.requireAuth);
  const runtime = createTerminalRuntime({ app, server, fs, path, uiAuthController: controller, ...security,
    buildAugmentedPath: () => process.env.PATH || '', searchPathFor: () => '/bin/sh', isExecutable: () => true,
    TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS: 30_000,
    loadPtyProvider: async () => ({ backend: 'fixture-pty', spawn: () => pty }), signalProcess() {} });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  const created = await fetch(`${base}/api/terminal/create`, { method: 'POST', headers: {
    ...Object.fromEntries(f.headers), 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'fixture-terminal', cwd: process.cwd(), shell: 'sh' }) });
  if (!created.ok) throw new Error(`Terminal creation failed: ${await created.text()}`);
  const open = async (headers = f.headers) => {
    const socket = new WebSocket(`${base.replace('http:', 'ws:')}/api/terminal/ws`, {
      headers: { ...Object.fromEntries(headers), Origin: config.baseURL }, handshakeTimeout: 3000 });
    peers.add(socket);
    const messages = [];
    socket.on('message', raw => messages.push(readTerminalWsControlFrame(raw)));
    socket.on('error', () => {});
    await new Promise((done, fail) => { socket.once('open', done); socket.once('error', fail); });
    return { socket, messages, send: message => socket.send(createTerminalWsControlFrame({ v: 3, s: 'fixture-terminal', ...message })) };
  };
  return { ...f, open, writes, output: data => output(data), killed: () => killed,
    close: async () => {
      for (const socket of peers) socket.terminate();
      await runtime.shutdown();
      server.closeAllConnections(); await new Promise(done => server.close(done));
      await f.close();
    } };
}

export async function until(predicate) {
  const deadline = Date.now() + 3500;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for terminal behavior');
    await new Promise(done => setTimeout(done, 5));
  }
}
