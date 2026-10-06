import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  countStashFiles,
  getBranchBase,
  getCommitFileDiff,
  getCommitFiles,
  getLog,
  getRangeDiff,
  getRangeFiles,
} from './service.js';
import { registerGitRoutes } from './routes.js';

// Git reads a revision argument that starts with `-` as an option, and
// `git show --output=<path>` creates or truncates that file. Every git read
// route must refuse such a value with a 400 and leave a file outside the
// repository untouched (openchamber#554 review, F3).

const runGit = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const commitAll = (cwd, message) => {
  runGit(cwd, ['add', '-A']);
  runGit(cwd, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-q', '-m', message]);
  return runGit(cwd, ['rev-parse', 'HEAD']).trim();
};

const CANARY_BYTES = 'canary bytes that must survive\n';
const roots = [];
let repository;
let canary;
let absent;
let headHash;

beforeAll(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-git-refusal-'));
  roots.push(root);
  repository = path.join(root, 'repository');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(repository);
  fs.mkdirSync(outside);
  canary = path.join(outside, 'canary');
  absent = path.join(outside, 'absent');
  fs.writeFileSync(canary, CANARY_BYTES);

  runGit(repository, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(repository, 'a.txt'), 'a\n');
  commitAll(repository, 'first');
  runGit(repository, ['branch', 'feature', 'main']);
  runGit(repository, ['switch', '-q', 'feature']);
  fs.writeFileSync(path.join(repository, 'b.txt'), 'b\n');
  headHash = commitAll(repository, 'second');
  fs.writeFileSync(path.join(repository, 'a.txt'), 'a changed\n');
  runGit(repository, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'stash', 'push', '-q']);
});

afterAll(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

const optionValues = () => [`--output=${canary}`, `--output=${absent}`];

const expectFilesUntouched = () => {
  expect(fs.readFileSync(canary, 'utf8')).toBe(CANARY_BYTES);
  expect(fs.existsSync(absent)).toBe(false);
};

const refused = { name: 'GitArgumentRefusedError', statusCode: 400 };

describe('git read service refuses option-like revision arguments', () => {
  const calls = {
    'getCommitFiles hash': (value) => getCommitFiles(repository, value),
    'getCommitFileDiff hash': (value) => getCommitFileDiff(repository, value, 'a.txt', false),
    'getBranchBase branch': (value) => getBranchBase(repository, value),
    'countStashFiles ref': (value) => countStashFiles(repository, [value]),
    'getLog to': (value) => getLog(repository, { to: value }),
    'getLog from': (value) => getLog(repository, { from: value }),
    'getRangeFiles base': (value) => getRangeFiles(repository, { base: value, head: 'HEAD' }),
    'getRangeFiles head': (value) => getRangeFiles(repository, { base: 'main', head: value }),
    'getRangeDiff base': (value) => getRangeDiff(repository, { base: value, head: 'HEAD' }),
    'getRangeDiff head': (value) => getRangeDiff(repository, { base: 'main', head: value }),
  };

  it.each(Object.keys(calls))('%s: --output=<outside path> is a 400 and writes nothing', async (label) => {
    for (const value of optionValues()) {
      await expect(calls[label](value)).rejects.toMatchObject(refused);
    }
    expectFilesUntouched();
  });

  it('refuses non-string and array values', async () => {
    await expect(getCommitFiles(repository, [headHash])).rejects.toMatchObject(refused);
    await expect(getCommitFiles(repository, 'HEAD')).rejects.toMatchObject(refused);
    await expect(getBranchBase(repository, ['feature'])).rejects.toMatchObject(refused);
    await expect(countStashFiles(repository, 'stash@{0}')).rejects.toMatchObject(refused);
    await expect(countStashFiles(repository, [['stash@{0}']])).rejects.toMatchObject(refused);
    await expect(getLog(repository, { to: ['HEAD'] })).rejects.toMatchObject(refused);
    await expect(getRangeFiles(repository, { base: ['main'], head: 'HEAD' })).rejects.toMatchObject(refused);
    expectFilesUntouched();
  });

  it('still reads through a commit hash, HEAD and named refs', async () => {
    const files = await getCommitFiles(repository, headHash);
    expect(files.files.map((file) => file.path)).toEqual(['b.txt']);
    const diff = await getCommitFileDiff(repository, headHash, 'b.txt', false);
    expect(diff).toMatchObject({ original: '', modified: 'b\n', isBinary: false });
    await expect(getBranchBase(repository, 'feature')).resolves.toEqual({ base: 'main' });
    await expect(countStashFiles(repository, ['stash@{0}'])).resolves.toEqual({ 'stash@{0}': 1 });
    const log = await getLog(repository, { maxCount: 5 });
    expect(log.all.map((entry) => entry.message)).toEqual(['second', 'first']);
    const range = await getLog(repository, { from: 'main', to: 'HEAD' });
    expect(range.all.map((entry) => entry.message)).toEqual(['second']);
    const rangeFiles = await getRangeFiles(repository, { base: 'main', head: 'HEAD' });
    expect(rangeFiles.map((file) => file.path)).toEqual(['b.txt']);
    expect(await getRangeDiff(repository, { base: 'main', head: 'HEAD' })).toContain('+b');
    expectFilesUntouched();
  });
});

describe('git read routes answer 400 for option-like revision arguments', () => {
  const createApp = () => {
    const app = express();
    app.use(express.json());
    registerGitRoutes(app);
    return app;
  };

  const requests = {
    'GET /api/git/commit-files': (app, value) => request(app).get('/api/git/commit-files').query({ directory: repository, hash: value }),
    'GET /api/git/commit-file-diff': (app, value) => request(app).get('/api/git/commit-file-diff').query({ directory: repository, hash: value, path: 'a.txt' }),
    'GET /api/git/branch-base': (app, value) => request(app).get('/api/git/branch-base').query({ directory: repository, branch: value }),
    'POST /api/git/stashes/file-counts': (app, value) => request(app).post('/api/git/stashes/file-counts').query({ directory: repository }).send({ refs: [value] }),
    'GET /api/git/log': (app, value) => request(app).get('/api/git/log').query({ directory: repository, to: value }),
    'GET /api/git/range-files': (app, value) => request(app).get('/api/git/range-files').query({ directory: repository, base: value, head: 'HEAD' }),
    'GET /api/git/range-diff': (app, value) => request(app).get('/api/git/range-diff').query({ directory: repository, base: 'main', head: value }),
  };

  it.each(Object.keys(requests))('%s refuses --output=<outside path> and writes nothing', async (label) => {
    const app = createApp();
    for (const value of optionValues()) {
      const response = await requests[label](app, value);
      expect(response.status, value).toBe(400);
    }
    expectFilesUntouched();
  });

  it('refuses repeated query values with a 400', async () => {
    const app = createApp();
    const directory = encodeURIComponent(repository);
    for (const url of [
      `/api/git/commit-files?directory=${directory}&hash=${headHash}&hash=${headHash}`,
      `/api/git/branch-base?directory=${directory}&branch=feature&branch=main`,
      `/api/git/log?directory=${directory}&to=HEAD&to=main`,
      `/api/git/range-files?directory=${directory}&base=main&base=main&head=HEAD`,
    ]) {
      const response = await request(app).get(url);
      expect(response.status, url).toBe(400);
    }
  });

  it('still serves a commit hash, HEAD and named refs', async () => {
    const app = createApp();
    const commitFiles = await request(app).get('/api/git/commit-files').query({ directory: repository, hash: headHash });
    expect(commitFiles.status).toBe(200);
    expect(commitFiles.body.files.map((file) => file.path)).toEqual(['b.txt']);
    const branchBase = await request(app).get('/api/git/branch-base').query({ directory: repository, branch: 'feature' });
    expect(branchBase.body).toEqual({ base: 'main' });
    const counts = await request(app).post('/api/git/stashes/file-counts').query({ directory: repository }).send({ refs: ['stash@{0}'] });
    expect(counts.body).toEqual({ counts: { 'stash@{0}': 1 } });
    const log = await request(app).get('/api/git/log').query({ directory: repository, from: 'main', to: 'HEAD' });
    expect(log.status).toBe(200);
    expect(log.body.all.map((entry) => entry.message)).toEqual(['second']);
    expectFilesUntouched();
  });
});
