import { EventEmitter } from 'events';
import path from 'path';
import { expect, it, vi } from 'vitest';
import { registerFsRoutes } from './routes.js';

const register = (env) => {
  const routes = new Map();
  const spawn = vi.fn(() => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
    queueMicrotask(() => child.emit('close', 0, null));
    return child;
  });
  registerFsRoutes({ get: (p, h) => routes.set(`GET ${p}`, h), post: (p, h) => routes.set(`POST ${p}`, h) }, {
    os: { homedir: () => '/home/user' }, path,
    fsPromises: { realpath: async p => p, stat: async () => ({ isDirectory: () => true }) },
    spawn, crypto: { randomUUID: () => 'job-0' }, normalizeDirectoryPath: p => p,
    resolveProjectDirectory: async () => ({ directory: '/repo' }), buildAugmentedPath: () => '/usr/bin',
    resolveGitBinaryForSpawn: () => 'git', openchamberUserConfigRoot: '/home/user/.config', env,
  });
  return { handler: routes.get('POST /api/fs/exec'), routes, spawn };
};
const call = async (handler, body) => {
  let statusCode = 200, payload = null;
  const res = { status(code) { statusCode = code; return this; }, json(value) { payload = value; return this; },
    setHeader() { return this; }, getHeader() {}, type() { return this; }, send(value) { payload = value; return this; } };
  await handler({ body, query: body }, res);
  return { statusCode, body: payload };
};

it('Node member command run gets the refusal and spawns no child', async () => {
  const { handler, spawn } = register({ PATH: '/usr/bin', SMARTY_CODE_NODE_ID: 'fixture-node' });
  const res = await call(handler, { commands: ['printf ok'], cwd: '/repo' });
  expect(res).toEqual({ statusCode: 403,
    body: { error: "Terminal and commands aren't available for members on this Node yet.", code: 'NODE_MEMBER_EXECUTION_REFUSED' } });
  expect(spawn).not.toHaveBeenCalled();
});

it('owner command run (no Node) is unchanged', async () => {
  const { handler, spawn } = register({ PATH: '/usr/bin' });
  const res = await call(handler, { commands: ['printf ok'], cwd: '/repo' });
  expect(res.statusCode).toBe(200);
  expect(spawn).toHaveBeenCalledTimes(1);
});

const GIT_REFUSAL = { error: "Changing Git metadata isn't available for members on this Node yet.", code: 'NODE_MEMBER_GIT_METADATA_REFUSED' };
const gitWrites = [['write', { path: '.git/config', content: '[core]\n\thooksPath = hooks\n' }],
  ['write', { path: 'sub/.git', content: 'gitdir: ../evil\n' }], ['upload', { path: 'repo/.GIT/hooks/pre-commit' }],
  ['mkdir', { path: '.git/hooks' }], ['delete', { path: '.git/hooks/pre-commit' }],
  ['rename', { oldPath: 'evil', newPath: '.git' }], ['clone', { remoteUrl: 'https://example.test/r.git', destinationPath: 'repo/.git/hooks' }]];
for (const [route, body] of gitWrites) {
  it(`Node member ${route} into Git metadata (${JSON.stringify(body)}) gets the refusal`, async () => {
    const { routes } = register({ PATH: '/usr/bin', SMARTY_CODE_NODE_ID: 'fixture-node' });
    expect(await call(routes.get(`POST /api/fs/${route}`), body)).toEqual({ statusCode: 403, body: GIT_REFUSAL });
  });
}

it('owner write into Git metadata (no Node) passes the guard', async () => {
  const { routes } = register({ PATH: '/usr/bin' });
  const res = await call(routes.get('POST /api/fs/write'), { path: '.git/config', content: 'x' }).catch(error => ({ statusCode: 500, error }));
  expect(res.body).not.toEqual(GIT_REFUSAL);
});

it('Node member ordinary file write is not refused by the Git guard', async () => {
  const { routes } = register({ PATH: '/usr/bin', SMARTY_CODE_NODE_ID: 'fixture-node' });
  const res = await call(routes.get('POST /api/fs/write'), { path: 'src/gitignore-notes.git.md', content: 'x' }).catch(error => ({ statusCode: 500, error }));
  expect(res.body).not.toEqual(GIT_REFUSAL);
});
