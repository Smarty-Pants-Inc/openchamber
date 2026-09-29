#!/usr/bin/env node
// The smartyfs#32 acceptance stress test: concurrent direct writers race co-edit saves, with the helper and the
// server killed at random. Pass = no revision is lost: every token a writer wrote, and every token of a save that
// reported published, is on disk, in the recovery directory or in the private directory at the end.
//
//   node stress.mjs [--seconds 60] [--dir <scratch parent>] [--seed <n>]
//
// The seed fixes the kill schedule (when, and helper or whole bridge); the writers' and person's pace stays random.
//
// Writers take turns among themselves (a mkdir lock) but never with the bridge, as agents, git and tools do. Each turn
// reads the file, adds one token line and writes it back in place (O_TRUNC), by tmp + rename, or by O_APPEND.
// The "server" is a child process running the bridge and a person typing and saving; it is SIGKILLed and restarted.
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as Y from 'yjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const kill = (pid) => {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
};
const role = arg('role', 'main');
/** mulberry32: a small seeded PRNG, so a kill schedule can be replayed. */
const seeded = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const home = arg('home', '');
const file = () => path.join(home, 'project', 'notes.md');
const log = (name, line) => fs.appendFileSync(path.join(home, 'logs', name), `${line}\n`);

async function writer(id) {
  const lock = path.join(home, 'writer.lock');
  const tmp = path.join(home, 'project', `.w${id}.tmp`);
  for (let n = 0; !fs.existsSync(path.join(home, 'stop')); n += 1) {
    try {
      fs.mkdirSync(lock);
    } catch {
      await sleep(1);
      n -= 1;
      continue;
    }
    const token = `W${id}-${n}`;
    const how = n % 3;
    try {
      if (how === 2) fs.appendFileSync(file(), `${token}\n`);
      else {
        const text = `${fs.existsSync(file()) ? fs.readFileSync(file(), 'utf8') : ''}${token}\n`;
        if (how === 0) fs.writeFileSync(file(), text);
        else {
          fs.writeFileSync(tmp, text);
          fs.renameSync(tmp, file());
        }
      }
      log(`writer-${id}`, token);
    } finally {
      fs.rmdirSync(lock);
    }
    await sleep(20 + Math.random() * 100); // An agent's pace: a write every 20-120 ms each.
  }
}

async function server(id) {
  process.env.OPENCHAMBER_COEDIT = '1';
  const { createDiskBridge, TEXT } = await import('./disk-bridge.js');
  const doc = new Y.Doc();
  const bridge = createDiskBridge({
    root: path.join(home, 'project'), file: file(), doc, recoveryDir: path.join(home, 'recovery'), settleMs: 20, debounceMs: 10, retryMs: 100,
    onConflict: (c) => log('conflicts', `${id} ${c.conflict}`),
  });
  await bridge.load();
  for (let n = 0; ; n += 1) {
    const token = `R${id}-${n}`;
    doc.getText(TEXT).insert(0, `${token}\n`);
    const result = await bridge.save().catch((error) => ({ error: String(error.message) }));
    // A save that published (ok, raced, or unconfirmed but on disk) must keep its bytes somewhere.
    if (result.ok || result.published === true) log('saved', token);
    log('results', `${token} ${JSON.stringify(result)}`);
    if (result.conflict === 'removed' || result.conflict === 'truncated') await bridge.acceptDisk();
    await sleep(Math.random() * 30);
  }
}

const everything = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? everything(p) : [fs.readFileSync(p, 'utf8')];
});

async function main() {
  const seconds = Number(arg('seconds', '60'));
  const seed = Number(arg('seed', String(Date.now() % 1_000_000)));
  const random = seeded(seed);
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(arg('dir', os.tmpdir()), 'coedit-stress-')));
  for (const d of ['project', 'logs']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  fs.mkdirSync(path.join(dir, 'recovery'), { mode: 0o700 });
  fs.chmodSync(path.join(dir, 'project'), 0o755);
  fs.writeFileSync(path.join(dir, 'project', 'notes.md'), 'start\n');
  const child = (...args) => spawn(process.execPath, [import.meta.filename, '--home', dir, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
  const writers = [0, 1, 2].map((id) => child('--role', 'writer', '--id', String(id)));
  let servers = 0;
  let serverProc = child('--role', 'server', '--id', String(servers));
  let kills = { server: 0, helper: 0 };
  const helperPids = () => fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p)).filter((p) => {
    try {
      const a = fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').split('\0');
      return a.some((x) => x.endsWith('coedit-fs')) && a.includes(path.join(dir, 'project'));
    } catch {
      return false;
    }
  }).map(Number);
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    await sleep(1000 + random() * 2000);
    if (random() < 0.6) {
      for (const pid of helperPids()) kill(pid);
      kills.helper += 1;
    } else {
      serverProc.kill('SIGKILL');
      kills.server += 1;
      await sleep(50);
      servers += 1;
      serverProc = child('--role', 'server', '--id', String(servers));
    }
  }
  fs.writeFileSync(path.join(dir, 'stop'), '');
  await Promise.all(writers.map((w) => new Promise((done) => w.on('exit', done))));
  serverProc.kill('SIGKILL');
  await sleep(300);
  // A last server finishes whatever the kills interrupted (its load keeps private entries in recovery).
  servers += 1;
  const last = child('--role', 'server', '--id', String(servers));
  await sleep(3000);
  last.kill('SIGKILL');
  for (const pid of helperPids()) kill(pid);
  const read = (name) => (fs.existsSync(path.join(dir, 'logs', name)) ? fs.readFileSync(path.join(dir, 'logs', name), 'utf8').split('\n').filter(Boolean) : []);
  const found = new Set([fs.readFileSync(path.join(dir, 'project', 'notes.md'), 'utf8'), ...everything(path.join(dir, 'recovery'))]
    .flatMap((text) => text.split('\n')));
  const written = [0, 1, 2].flatMap((id) => read(`writer-${id}`));
  const saved = read('saved');
  const lostWrites = written.filter((t) => !found.has(t));
  const lostSaves = saved.filter((t) => !found.has(t));
  const conflicts = {};
  for (const line of read('conflicts')) conflicts[line.split(' ')[1]] = (conflicts[line.split(' ')[1]] ?? 0) + 1;
  const report = {
    seconds, seed, dir, writes: written.length, saves: saved.length, attempts: read('results').length, servers: servers + 1, kills, conflicts,
    lostWrites: lostWrites.length, lostSaves: lostSaves.length, examples: [...lostWrites, ...lostSaves].slice(0, 10),
  };
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = lostWrites.length || lostSaves.length ? 1 : 0;
}

if (role === 'writer') await writer(Number(arg('id', '0')));
else if (role === 'server') await server(Number(arg('id', '0')));
else await main();
