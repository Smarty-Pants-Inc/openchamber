import assert from 'node:assert/strict';
import { vi } from 'vitest';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { betterAuth } from 'better-auth';
import { testUtils } from 'better-auth/plugins';
import express from 'express';
import { WebSocket } from 'ws';
import { createHumanAuth } from '../ui-auth/human-auth.js';
import { createUiAuth } from '../ui-auth/ui-auth.js';
import { configureApplicationHosts } from '../security/browser-origin.js';
import { createRequestSecurityRuntime } from '../security/request-security.js';
import { DictationStreamManager } from './stream-manager.js';
import { OpenAICompatibleTranscriptionSession } from './openai-compatible-session.js';
import { createDictationRuntime } from './runtime.js';

export const issuer = 'https://code.smartypants.ai';
export const waitFor = async (predicate) => {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'dictation lifetime observation timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

export async function fixture() {
  const database = new DatabaseSync(':memory:');
  const human = await createHumanAuth({ database, baseURL: issuer,
    secret: 'private-dictation-fixture-secret-thirty-two-characters', googleClientId: 'fixture',
    googleClientSecret: 'fixture', allowedDomains: ['example.test'] });
  // Keep the fixture's short database expiry; Better Auth otherwise refreshes it on admission.
  (await human.auth.$context).options.session.disableSessionRefresh = true;
  const testAuth = betterAuth({ ...human.auth.options,
    user: { ...human.auth.options.user, validateUserInfo: undefined }, plugins: [testUtils()] });
  const helpers = (await testAuth.$context).test;
  const user = await helpers.saveUser(helpers.createUser({ email: 'dictation@example.test', emailVerified: true }));
  const adapter = (await human.auth.$context).internalAdapter;
  const person = async (expiresAt) => {
    const headers = Object.fromEntries(await helpers.getAuthHeaders({ userId: user.id }));
    const session = (await human.resolve({ headers })).session;
    if (expiresAt) await adapter.updateSession(session.token, { expiresAt });
    return { headers: { ...headers, Host: 'code.smartypants.ai', Origin: issuer }, session };
  };
  configureApplicationHosts(async () => ['code.smartypants.ai']);
  const app = express(), server = createServer(app), peers = [];
  const security = createRequestSecurityRuntime({ readSettingsFromDiskMigrated: async () => ({ publicOrigin: issuer }) });
  const cleanup = vi.spyOn(DictationStreamManager.prototype, 'cleanupAll');
  const closedSessions = [], originalClose = OpenAICompatibleTranscriptionSession.prototype.close;
  const close = vi.spyOn(OpenAICompatibleTranscriptionSession.prototype, 'close').mockImplementation(function () {
    originalClose.call(this); closedSessions.push(this);
  });
  const controller = createUiAuth({ humanAuth: human });
  app.post('/fixture/login', express.json(), (req, res) => controller.handleSessionCreate(req, res));
  const runtime = createDictationRuntime({ app, server, express, uiAuthController: controller, ...security,
    modelsDir: process.env.TMPDIR });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const open = (headers) => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/dictation/ws`, { headers, handshakeTimeout: 2000 });
    const peer = { socket, messages: [], outcome: null, closed: false };
    peers.push(peer);
    socket.on('message', raw => peer.messages.push(JSON.parse(raw.toString())));
    socket.once('open', () => { peer.outcome = 101; });
    socket.once('close', () => { peer.closed = true; });
    socket.once('unexpected-response', (_req, res) => {
      peer.outcome = res.statusCode; res.resume(); socket.terminate();
    });
    socket.on('error', () => { peer.outcome ??= 'disconnected'; });
    return peer;
  };
  return { human, adapter, person, open, cleanup, closedSessions, runtime, controller,
    login: () => fetch(`http://127.0.0.1:${server.address().port}/fixture/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'fixture-password' }),
    }),
    async dispose() {
      runtime.stop();
      for (const peer of peers) peer.socket.terminate();
      await waitFor(() => peers.every(peer => peer.closed));
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => server.close(resolve));
      cleanup.mockRestore(); close.mockRestore(); human.dispose(); database.close();
      configureApplicationHosts(async () => []);
    } };
}

export async function ready(f, person) {
  const peer = f.open(person.headers);
  await waitFor(() => peer.messages.some(m => m.type === 'ready'));
  peer.socket.send(JSON.stringify({ type: 'ping' }));
  await waitFor(() => peer.messages.some(m => m.type === 'pong'));
  return peer;
}
export async function bufferAudio(peer) {
  // This real service session only buffers local PCM. No commit, HTTP provider call or model download.
  peer.socket.send(JSON.stringify({ type: 'start', dictationId: 'private', format: 'audio/pcm;rate=16000;bits=16',
    options: { provider: 'openai-compatible', openaiCompatible: { baseUrl: 'http://127.0.0.1:1', model: 'fixture' } } }));
  await waitFor(() => peer.messages.some(m => m.type === 'ack' && m.ackSeq === -1));
  peer.socket.send(JSON.stringify({ type: 'chunk', dictationId: 'private', seq: 0, audio: 'QB9AH0AfQB8=' }));
  await waitFor(() => peer.messages.some(m => m.type === 'ack' && m.ackSeq === 0));
}
