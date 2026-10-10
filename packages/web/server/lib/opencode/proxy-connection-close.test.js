import { spawn } from 'node:child_process';
import { channel } from 'node:diagnostics_channel';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

import express from 'express';
import { describe, expect, it } from 'vitest';

import { registerOpenCodeProxy } from './proxy.js';

// Node's HTTP server advertises close correctly and does not reproduce this.
// Bun closes the socket but its response allows Node's agent to pool it first.
const bunUpstream = `
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(request, server) {
      return Response.json({
        ok: true,
        connection: request.headers.get('connection'),
        remotePort: server.requestIP(request).port,
      });
    },
  });
  console.log(server.port);
`;

const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    server.removeListener('error', reject);
    resolve(server.address().port);
  });
});

const closeServer = (server) => new Promise((resolve, reject) => {
  server.close((error) => error ? reject(error) : resolve());
  server.closeAllConnections();
});

const read = (port, agent, connection) => new Promise((resolve, reject) => {
  const request = http.get({
    host: '127.0.0.1', port, path: '/api/probe', agent,
    headers: { connection },
  }, (response) => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', (chunk) => { body += chunk; });
    response.on('end', () => resolve({ status: response.statusCode, body }));
    response.on('error', reject);
  });
  request.on('error', reject);
  request.setTimeout(5_000, () => request.destroy(new Error('Client read timed out')));
});

const withProxy = async (run) => {
  const child = spawn('bun', ['--eval', bunUpstream], { stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise((resolve) => {
    child.once('exit', resolve);
    child.once('error', resolve);
  });
  const lines = createInterface({ input: child.stdout });
  const clientAgent = new http.Agent({ keepAlive: true });
  const upstreamAgents = new Set();
  const outgoing = [];
  const requests = channel('http.client.request.start');
  let upstreamPort;
  let front;
  // Observe native requests without replacing the production agent or hook.
  const observe = ({ request }) => {
    if (request.getHeader('host') !== `127.0.0.1:${upstreamPort}`) return;
    upstreamAgents.add(request.agent);
    const record = {
      reused: request.reusedSocket,
      connection: request.getHeader('connection'),
      localPort: request.socket.localPort,
    };
    outgoing.push(record);
    request.on('error', (error) => { record.error = error.code; });
  };
  requests.subscribe(observe);

  try {
    const [line] = await Promise.race([
      once(lines, 'line', { signal: AbortSignal.timeout(5_000) }),
      exited.then(() => { throw new Error('Bun upstream exited before listening'); }),
    ]);
    upstreamPort = Number(line);
    expect(upstreamPort).toBeGreaterThan(0);
    const app = express();
    registerOpenCodeProxy(app, {
      fs, os, path, OPEN_CODE_READY_GRACE_MS: 0,
      getRuntime: () => ({
        openCodePort: upstreamPort, isOpenCodeReady: true,
        openCodeNotReadySince: 0, isRestartingOpenCode: false,
      }),
      getOpenCodeAuthHeaders: () => ({}),
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:${upstreamPort}${pathname}`,
      ensureOpenCodeApiPrefix: () => {},
    });
    front = http.createServer(app);
    const port = await listen(front);
    await run({ read: (connection) => read(port, clientAgent, connection), outgoing });
  } finally {
    requests.unsubscribe(observe);
    lines.close();
    clientAgent.destroy();
    for (const agent of upstreamAgents) agent.destroy();
    try {
      if (front) await closeServer(front);
    } finally {
      child.kill();
      await exited;
    }
  }
};

describe('production OpenCode proxy connection ownership', () => {
  it('does not turn close-client reads into 503s on reused upstream sockets', async () => {
    await withProxy(async ({ read, outgoing }) => {
      const responses = [];
      // Concurrent reads reproduce the FIN/reuse window. Response completion
      // drives each following batch; no sleep or injected reset is involved.
      for (let round = 0; round < 12; round += 1) {
        responses.push(...await Promise.all(Array.from({ length: 32 }, () => read('close'))));
      }
      const failures = responses.filter((response) => response.status !== 200);
      const evidence = {
        reads: responses.length, failures: failures.length,
        reused: outgoing.filter((request) => request.reused).length,
        reusedResets: outgoing.filter((request) => request.reused && request.error === 'ECONNRESET').length,
        forwardedClose: outgoing.filter((request) => request.connection === 'close').length,
      };
      console.log('connection-close evidence', JSON.stringify(evidence));
      expect(evidence.reused).toBeGreaterThan(0);
      expect(failures, JSON.stringify(evidence)).toEqual([]);
      expect(evidence.reusedResets).toBe(0);
      expect(responses.every((response) => JSON.parse(response.body).ok)).toBe(true);
      expect(responses.every((response) => JSON.parse(response.body).connection !== 'close')).toBe(true);
    });
  });

  it('keeps normal keep-alive clients and upstream socket reuse working', async () => {
    await withProxy(async ({ read, outgoing }) => {
      const first = await read('keep-alive');
      const second = await read('keep-alive');
      expect([first.status, second.status]).toEqual([200, 200]);
      const firstBody = JSON.parse(first.body);
      const secondBody = JSON.parse(second.body);
      expect(firstBody.ok).toBe(true);
      expect(secondBody.ok).toBe(true);
      expect(firstBody.connection).not.toBe('close');
      expect(secondBody.connection).not.toBe('close');
      expect(secondBody.remotePort).toBe(firstBody.remotePort);
      expect(outgoing.map((request) => request.reused)).toEqual([false, true]);
      expect(outgoing.map((request) => request.localPort)).toEqual([firstBody.remotePort, firstBody.remotePort]);
      console.log('keep-alive evidence', JSON.stringify({ reads: 2, failures: 0, reused: 1 }));
    });
  });
});
