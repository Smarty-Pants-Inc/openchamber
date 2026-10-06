import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

import { registerTtsRoutes } from './routes.js';
import { normalizeCustomOpenAIBaseURL } from './base-url.js';

const createApp = (sayTTSCapability = null) => {
  const app = express();
  app.use(express.json());
  registerTtsRoutes(app, {
    resolveZenModel: async () => 'gpt-5-nano',
    sayTTSCapability,
  });
  return app;
};

describe('tts routes', () => {
  it('waits for the authoritative macOS say capability', async () => {
    let resolveCapability;
    const capability = new Promise((resolve) => {
      resolveCapability = resolve;
    });
    const pending = request(createApp(capability)).get('/api/tts/say/status');

    resolveCapability({ available: true, voices: [{ name: 'Samantha', locale: 'en_US' }] });

    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      available: true,
      voices: [{ name: 'Samantha', locale: 'en_US' }],
    });
  });

  it('switches the say voice to the language of the text when asked to', async () => {
    const capability = Promise.resolve({
      available: true,
      voices: [
        { name: 'Samantha', locale: 'en_US' },
        { name: 'Lesya', locale: 'uk_UA' },
        { name: 'Lesya (Enhanced)', locale: 'uk_UA' },
      ],
    });
    const app = createApp(capability);
    const response = await request(app)
      .post('/api/tts/say/speak')
      .send({ text: 'Привіт! Це відповідь українською мовою, і вона досить довга.', voice: 'Samantha', language: 'auto' });

    // On macOS the route synthesizes; elsewhere it refuses before running say.
    // Either way the chosen voice must be the Ukrainian one when the platform
    // allows the request to proceed.
    if (process.platform === 'darwin') {
      expect(response.status).toBe(200);
      expect(response.headers['x-speech-voice']).toBe('Lesya (Enhanced)');
      expect(response.headers['x-speech-language']).toBe('uk');
    } else {
      expect(response.status).toBe(503);
    }
  });

  it('returns local note fallback while model summarization is retired', async () => {
    const response = await request(createApp())
      .post('/api/text/summarize')
      .send({
        text: 'First sentence. Second sentence with the useful insight.',
        threshold: 0,
        maxLength: 100,
        mode: 'note',
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      summary: 'First sentence.',
      summarized: false,
      reason: 'Model summarization provider unavailable',
    });
  });

  it('keeps notification fallback behavior without calling zen', async () => {
    const response = await request(createApp())
      .post('/api/text/summarize')
      .send({
        text: 'Notification text that should fall back cleanly.',
        threshold: 0,
        maxLength: 100,
        mode: 'notification',
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      summary: 'Notification text that should fall back cleanly.',
      summarized: false,
      reason: 'Model summarization provider unavailable',
    });
  });
});

// A stand-in `say` on PATH records its argv and stdin and writes the audio
// file, so the argument boundary is observable on every platform.
describe.skipIf(process.platform === 'win32')('macOS say speak argument boundary', () => {
  const voices = [{ name: 'Samantha', locale: 'en_US' }, { name: 'Lesya (Enhanced)', locale: 'uk_UA' }];
  const originalPath = process.env.PATH;
  const originalLog = process.env.FAKE_SAY_LOG;
  let root;
  let marker;
  let argvLog;
  let stdinLog;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-say-'));
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    const say = path.join(bin, 'say');
    fs.writeFileSync(say, [
      '#!/bin/sh',
      'out=""',
      'prev=""',
      'for arg in "$@"; do',
      '  printf \'%s\\n\' "$arg" >> "$FAKE_SAY_LOG.argv"',
      '  if [ "$prev" = "-o" ]; then out="$arg"; fi',
      '  prev="$arg"',
      'done',
      'cat > "$FAKE_SAY_LOG.stdin"',
      'printf \'fake-audio\' > "$out"',
      '',
    ].join('\n'));
    fs.chmodSync(say, 0o755);
    marker = path.join(root, 'marker');
    argvLog = path.join(root, 'say.argv');
    stdinLog = path.join(root, 'say.stdin');
    process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
    process.env.FAKE_SAY_LOG = path.join(root, 'say');
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    if (originalLog === undefined) delete process.env.FAKE_SAY_LOG;
    else process.env.FAKE_SAY_LOG = originalLog;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const speak = (body) => {
    const app = express();
    app.use(express.json());
    registerTtsRoutes(app, { sayTTSCapability: Promise.resolve({ available: true, voices }), platform: 'darwin' });
    return request(app).post('/api/tts/say/speak').send(body);
  };

  // Cases take the marker path at run time: it exists only once beforeEach ran.
  it.each([
    ['single and double quotes', (target) => `it's a "quoted" line'; touch ${target}; echo '`],
    ['command substitution', (target) => `$(touch ${target}) and \`touch ${target}\``],
    ['separators', (target) => `hello; touch ${target} && touch ${target} | touch ${target}`],
    ['a leading option', (target) => `-o ${target}`],
  ])('speaks text with %s as stdin data, never as a command or option', async (_label, textFor) => {
    const text = textFor(marker);
    const response = await speak({ text, voice: 'Samantha', rate: 200 });

    expect(response.status).toBe(200);
    expect(response.headers['x-speech-voice']).toBe('Samantha');
    expect(fs.readFileSync(stdinLog, 'utf8')).toBe(text);
    const argv = fs.readFileSync(argvLog, 'utf8').split('\n').filter(Boolean);
    expect(argv.slice(0, 4)).toEqual(['-v', 'Samantha', '-r', '200']);
    expect(argv[4]).toBe('-o');
    expect(argv.slice(6)).toEqual(['--data-format=aac']);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it.each([
    ['voice with quotes and a separator', (target) => ({ voice: `Samantha" ; touch ${target}; "`, rate: 200 })],
    ['voice with command substitution', (target) => ({ voice: `$(touch ${target})`, rate: 200 })],
    ['voice with backticks', (target) => ({ voice: `\`touch ${target}\``, rate: 200 })],
    ['voice that is an option', () => ({ voice: '--help', rate: 200 })],
    ['voice that is not installed', () => ({ voice: 'Nobody', rate: 200 })],
    ['rate with a separator', (target) => ({ voice: 'Samantha', rate: `200; touch ${target}` })],
    ['rate with command substitution', (target) => ({ voice: 'Samantha', rate: `$(touch ${target})` })],
    ['non-numeric rate', () => ({ voice: 'Samantha', rate: 'fast' })],
    ['numeric-string rate', () => ({ voice: 'Samantha', rate: '200' })],
    ['rate below the range', () => ({ voice: 'Samantha', rate: 10 })],
    ['rate above the range', () => ({ voice: 'Samantha', rate: 1e9 })],
  ])('refuses a %s with a 400 before say runs', async (_label, fieldsFor) => {
    const response = await speak({ text: 'Hello there.', ...fieldsFor(marker) });

    expect(response.status).toBe(400);
    expect(fs.existsSync(argvLog)).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('refuses an invalid voice on every platform, before the macOS check', async () => {
    const response = await request(createApp(Promise.resolve({ available: false, voices: [] })))
      .post('/api/tts/say/speak')
      .send({ text: 'Hello there.', voice: `$(touch ${marker})`, rate: 200 });

    expect(response.status).toBe(400);
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe('normalizeCustomOpenAIBaseURL', () => {
  const originalRuntime = process.env.OPENCHAMBER_RUNTIME;
  const originalAllowRemote = process.env.OPENCHAMBER_ALLOW_REMOTE_OPENAI_COMPAT_URLS;

  afterEach(() => {
    // Restore env vars after each test
    if (originalRuntime === undefined) {
      delete process.env.OPENCHAMBER_RUNTIME;
    } else {
      process.env.OPENCHAMBER_RUNTIME = originalRuntime;
    }
    if (originalAllowRemote === undefined) {
      delete process.env.OPENCHAMBER_ALLOW_REMOTE_OPENAI_COMPAT_URLS;
    } else {
      process.env.OPENCHAMBER_ALLOW_REMOTE_OPENAI_COMPAT_URLS = originalAllowRemote;
    }
  });

  it('rejects remote URLs when OPENCHAMBER_RUNTIME is not set (web)', () => {
    delete process.env.OPENCHAMBER_RUNTIME;
    delete process.env.OPENCHAMBER_ALLOW_REMOTE_OPENAI_COMPAT_URLS;

    const result = normalizeCustomOpenAIBaseURL('https://my-tts-server.example.com/v1');
    expect(result.error).toMatch(/Remote custom server URLs are disabled/);
    expect(result.value).toBeUndefined();
  });

  it('allows remote URLs when OPENCHAMBER_RUNTIME is desktop', () => {
    process.env.OPENCHAMBER_RUNTIME = 'desktop';
    delete process.env.OPENCHAMBER_ALLOW_REMOTE_OPENAI_COMPAT_URLS;

    const result = normalizeCustomOpenAIBaseURL('https://my-tts-server.example.com/v1');
    expect(result.error).toBeUndefined();
    expect(result.value).toBe('https://my-tts-server.example.com/v1');
  });

  it('allows remote URLs when OPENCHAMBER_ALLOW_REMOTE_OPENAI_COMPAT_URLS is true', () => {
    delete process.env.OPENCHAMBER_RUNTIME;
    process.env.OPENCHAMBER_ALLOW_REMOTE_OPENAI_COMPAT_URLS = 'true';

    const result = normalizeCustomOpenAIBaseURL('https://my-tts-server.example.com/v1');
    expect(result.error).toBeUndefined();
    expect(result.value).toBe('https://my-tts-server.example.com/v1');
  });

  it('allows localhost URLs regardless of runtime', () => {
    delete process.env.OPENCHAMBER_RUNTIME;
    delete process.env.OPENCHAMBER_ALLOW_REMOTE_OPENAI_COMPAT_URLS;

    const result = normalizeCustomOpenAIBaseURL('http://localhost:8880/v1');
    expect(result.error).toBeUndefined();
    expect(result.value).toBe('http://localhost:8880/v1');
  });

  it('strips query strings and trailing slashes', () => {
    process.env.OPENCHAMBER_RUNTIME = 'desktop';

    const result = normalizeCustomOpenAIBaseURL('https://my-server.com/v1/?key=123');
    expect(result.value).toBe('https://my-server.com/v1');
  });

  it('denies remote URLs on desktop when env var is explicitly false', () => {
    process.env.OPENCHAMBER_RUNTIME = 'desktop';
    process.env.OPENCHAMBER_ALLOW_REMOTE_OPENAI_COMPAT_URLS = 'false';

    const result = normalizeCustomOpenAIBaseURL('https://my-tts-server.example.com/v1');
    expect(result.error).toMatch(/Remote custom server URLs are disabled/);
    expect(result.value).toBeUndefined();
  });
});
