import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';

import { createCoeditAdmission } from './admit.js';
import { createDiskBridge, TEXT } from './disk-bridge.js';
import { attachCoeditRooms, COEDIT_WS_PATH, CONFLICT_MESSAGE } from './rooms.js';

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A real server with co-edit rooms over a temp project; `allow` decides the auth and origin checks. */
const setup = async ({ allow = true, createBridge } = {}) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coedit-rooms-')));
  const root = path.join(home, 'project');
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  const file = path.join(root, 'docs', 'plan.md');
  fs.writeFileSync(file, 'plan\n');
  fs.writeFileSync(path.join(root, 'docs', 'other.md'), 'other\n');
  const server = http.createServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const rejected = [];
  const rooms = attachCoeditRooms({
    server,
    ensureAuthenticated: async () => allow,
    originAllowed: async () => allow,
    rejectWebSocketUpgrade: (socket, status) => { rejected.push(status); socket.destroy(); },
    admit: createCoeditAdmission({
      resolveProjectDirectory: async (req) => (req.query.directory === root ? { directory: root } : { directory: null, error: 'Unknown project' }),
      normalizeDirectoryPath: (value) => value,
    }),
    recoveryRoot: path.join(home, 'recovery'),
    debounce: 100,
    ...(createBridge ? { createBridge } : {}),
  });
  cleanups.push(async () => {
    await rooms.stop();
    await new Promise((done) => server.close(done));
    fs.rmSync(home, { recursive: true, force: true });
  });
  const port = server.address().port;
  /** A person's editor: a provider for `name`, admitted for `file` (they differ only in the refusal test). */
  const join = (name = file, admitted = file) => {
    const doc = new Y.Doc();
    const url = `ws://127.0.0.1:${port}${COEDIT_WS_PATH}?directory=${encodeURIComponent(root)}&path=${encodeURIComponent(admitted)}`;
    const stateless = [];
    const provider = new HocuspocusProvider({ url, name, document: doc, token: 'session',
      onStateless: ({ payload }) => stateless.push(JSON.parse(payload)) });
    cleanups.push(() => provider.destroy());
    return { doc, text: doc.getText(TEXT), provider, stateless };
  };
  return { home, root, file, join, rejected, disk: () => fs.readFileSync(file, 'utf8') };
};

describe('co-edit rooms (smartyfs#18)', () => {
  it('two people in one room: each sees the file and the other, the save reaches the disk, an outside write reaches both', async () => {
    const t = await setup();
    const paul = t.join();
    const kate = t.join();
    await expect.poll(() => [paul.text.toString(), kate.text.toString()], { timeout: 5000 }).toEqual(['plan\n', 'plan\n']);
    paul.text.insert(0, 'Paul: ');
    await expect.poll(() => kate.text.toString(), { timeout: 5000 }).toBe('Paul: plan\n');
    kate.text.insert(kate.text.length, 'Kate\n');
    await expect.poll(() => t.disk(), { timeout: 5000 }).toBe('Paul: plan\nKate\n');
    fs.writeFileSync(t.file, 'Paul: plan\nKate\nagent\n');
    await expect.poll(() => [paul.text.toString(), kate.text.toString()], { timeout: 5000 })
      .toEqual(['Paul: plan\nKate\nagent\n', 'Paul: plan\nKate\nagent\n']);
  });

  it('a connection opens only the file it was admitted for', async () => {
    const t = await setup();
    const other = path.join(t.root, 'docs', 'other.md');
    const sneaky = t.join(other, t.file); // Admitted for plan.md, asks for other.md.
    await new Promise((done) => setTimeout(done, 1000));
    expect(sneaky.text.toString()).toBe('');
    sneaky.text.insert(0, 'x');
    await new Promise((done) => setTimeout(done, 500));
    expect(fs.readFileSync(other, 'utf8')).toBe('other\n');
  });

  it('refuses an unauthenticated upgrade, and a file outside the admitted project', async () => {
    const denied = await setup({ allow: false });
    denied.join();
    await expect.poll(() => denied.rejected, { timeout: 3000 }).toContain(401);
    const t = await setup();
    const outside = path.join(t.home, 'secret.md');
    fs.writeFileSync(outside, 'secret\n');
    t.join(outside, outside);
    await expect.poll(() => t.rejected, { timeout: 3000 }).toContain(403);
  });

  it('a conflict reaches the people in the room as a stateless message', async () => {
    let raise = null;
    const t = await setup({ createBridge: (options) => { raise = options.onConflict; return createDiskBridge(options); } });
    const paul = t.join();
    await expect.poll(() => paul.text.toString(), { timeout: 5000 }).toBe('plan\n');
    raise({ conflict: 'changed', at: 1 });
    await expect.poll(() => paul.stateless, { timeout: 3000 })
      .toEqual([{ type: CONFLICT_MESSAGE, conflict: 'changed', at: 1, recovered: false }]);
  });
});
