import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { createUiAuth } from '../ui-auth/ui-auth.js';
import { OpenAICompatibleTranscriptionSession } from './openai-compatible-session.js';
import { bufferAudio, fixture, issuer, ready, waitFor } from './human-session-fixture.js';

for (const end of ['revocation', 'expiry']) test(`dictation ${end} closes only that human session and cancels buffered work`, async () => {
  const f = await fixture();
  try {
    const person = await f.person(end === 'expiry' ? new Date(Date.now() + 1500) : undefined);
    const healthy = await ready(f, await f.person()), peer = await ready(f, person);
    await bufferAudio(peer);
    if (end === 'revocation') await f.adapter.deleteSession(person.session.token);
    await waitFor(() => peer.closed);
    await waitFor(() => f.cleanup.mock.calls.length === 1 && f.closedSessions.length === 1);
    assert.equal(f.closedSessions[0].connected, false);
    assert.equal(f.closedSessions[0].pcm16.length, 0);
    const count = peer.messages.length;
    const sendError = await new Promise(resolve => peer.socket.send(JSON.stringify({ type: 'start' }), resolve));
    assert.ok(sendError, 'closed peer must reject later work');
    assert.equal(peer.messages.length, count);
    const rejected = f.open(person.headers);
    await waitFor(() => rejected.outcome !== null);
    assert.equal(rejected.outcome, 401);
    healthy.messages.length = 0; healthy.socket.send(JSON.stringify({ type: 'ping' }));
    await waitFor(() => healthy.messages.some(m => m.type === 'pong'));
    assert.equal(healthy.closed, false);
    assert.equal(f.cleanup.mock.calls.length, 1);
  } finally { await f.dispose(); }
});

test('dictation deletion during the authoritative admission recheck never upgrades', async () => {
  const f = await fixture();
  let lookup;
  try {
    const person = await f.person(), getSession = f.human.auth.api.getSession;
    let resolves = 0;
    lookup = vi.spyOn(f.human.auth.api, 'getSession').mockImplementation(async (...args) => {
      const session = await getSession(...args);
      if (++resolves === 2) await f.adapter.deleteSession(person.session.token);
      return session; // Real result; deletion hook destroys the registered raw socket before next().
    });
    const peer = f.open(person.headers);
    await waitFor(() => peer.outcome !== null);
    assert.equal(resolves, 2);
    assert.equal(peer.outcome, 'disconnected');
    assert.equal(peer.messages.length, 0);
    assert.equal(f.cleanup.mock.calls.length, 0, 'no dictation manager is admitted');
    assert.equal(f.closedSessions.length, 0);
  } finally { lookup?.mockRestore(); await f.dispose(); }
});

test('dictation healthy human supports control/cancel and runtime stop cleans its service session', async () => {
  const f = await fixture();
  try {
    const peer = await ready(f, await f.person());
    await bufferAudio(peer);
    peer.socket.send(JSON.stringify({ type: 'cancel', dictationId: 'private' }));
    await waitFor(() => f.closedSessions.length === 1);
    peer.messages.length = 0;
    await bufferAudio(peer);
    f.runtime.stop();
    await waitFor(() => peer.closed && f.cleanup.mock.calls.length === 1 && f.closedSessions.length === 2);
    assert.ok(f.closedSessions.every(session => !session.connected && session.pcm16.length === 0));
  } finally { await f.dispose(); }
});

test('dictation keeps Host-first denial, exact human Origin and passwordless admission', async () => {
  const f = await fixture();
  try {
    const person = await f.person();
    for (const [headers, code] of [
      [{ Host: 'unbound.example.test', Origin: 'null' }, 403],
      [{ ...person.headers, Host: 'unbound.example.test', 'X-Forwarded-Host': 'code.smartypants.ai' }, 403],
      [{ Host: 'code.smartypants.ai', Origin: issuer }, 401],
      [{ ...person.headers, Origin: 'https://attacker.test' }, 403],
    ]) {
      const peer = f.open(headers); await waitFor(() => peer.outcome !== null); assert.equal(peer.outcome, code);
    }
    assert.equal(f.cleanup.mock.calls.length, 0);
    assert.equal(f.closedSessions.length, 0);
    Object.assign(f.controller, createUiAuth({})); delete f.controller.humanMode;
    const peer = f.open({ Host: '127.0.0.1', Origin: 'http://127.0.0.1' });
    await waitFor(() => peer.outcome !== null); assert.equal(peer.outcome, 101);
  } finally { await f.dispose(); }
});

test('dictation pending service start is closed when it resolves after socket cleanup', async () => {
  const f = await fixture(), connect = OpenAICompatibleTranscriptionSession.prototype.connect;
  let release, pending;
  const gate = new Promise(resolve => { release = resolve; });
  const start = vi.spyOn(OpenAICompatibleTranscriptionSession.prototype, 'connect').mockImplementation(async function () {
    await connect.call(this); pending = this; await gate;
  });
  try {
    const person = await f.person(), peer = await ready(f, person);
    peer.socket.send(JSON.stringify({ type: 'start', dictationId: 'pending', format: 'audio/pcm;rate=16000;bits=16',
      options: { provider: 'openai-compatible', openaiCompatible: { baseUrl: 'http://127.0.0.1:1', model: 'fixture' } } }));
    await waitFor(() => pending?.connected);
    await f.adapter.deleteSession(person.session.token);
    await waitFor(() => peer.closed && f.cleanup.mock.calls.length === 1);
    assert.equal(f.closedSessions.length, 0, 'the start has not yet installed a manager stream');
    release();
    await waitFor(() => f.closedSessions.length === 1);
    assert.equal(pending.connected, false);
    assert.equal(peer.messages.filter(message => message.type === 'ack').length, 0);
  } finally { release(); start.mockRestore(); await f.dispose(); }
});

test('dictation UI-password keeps its existing session and Origin gates', async () => {
  const f = await fixture(), password = createUiAuth({ password: 'fixture-password' });
  try {
    Object.assign(f.controller, password); delete f.controller.humanMode;
    const response = await f.login(); assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie').split(';')[0];
    for (const [headers, code] of [
      [{ Host: 'code.smartypants.ai', Origin: issuer }, 401],
      [{ Host: 'code.smartypants.ai', Origin: 'https://attacker.test', Cookie: cookie }, 403],
      [{ Host: 'code.smartypants.ai', Origin: issuer, Cookie: cookie }, 101],
    ]) {
      const peer = f.open(headers); await waitFor(() => peer.outcome !== null); assert.equal(peer.outcome, code);
    }
  } finally { password.dispose(); await f.dispose(); }
});
