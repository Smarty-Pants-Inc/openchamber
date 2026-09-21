import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { createHumanAuth } from './human-auth.js';
import { createHumanAudience } from './human-audience.js';

/** Ordinary injected environment only; credential delivery and activation belong to the caller. */
export async function createConfiguredHumanAuth(env) {
  const mode = env.OPENCHAMBER_HUMAN_AUTH;
  if (mode === undefined || mode === '' || mode === 'off') return null;
  if (mode !== 'google') throw new Error('OPENCHAMBER_HUMAN_AUTH must be google or off');
  for (const key of ['OPENCHAMBER_HUMAN_AUTH_DB', 'BETTER_AUTH_URL', 'BETTER_AUTH_SECRET',
    'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'SMARTY_HUMAN_AUTH_ALLOWED_DOMAINS']) {
    if (typeof env[key] !== 'string' || !env[key].trim()) throw new Error(`Human authentication requires ${key}`);
  }
  const path = env.OPENCHAMBER_HUMAN_AUTH_DB;
  if (!isAbsolute(path)) throw new Error('Human authentication database path must be absolute');
  const allowedDomains = env.SMARTY_HUMAN_AUTH_ALLOWED_DOMAINS.split(',').map(value => value.trim());
  createHumanAudience(allowedDomains);
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = await lstat(parent);
  if (!directory.isDirectory() || (directory.mode & 0o077)) throw new Error('Human authentication requires a private database directory');
  try {
    const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    await file.close();
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const file = await lstat(path);
  if (!file.isFile() || (file.mode & 0o077)) throw new Error('Human authentication requires a private regular database file');
  // Keep legacy startup independent of Node's SQLite availability when human mode is off.
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(path);
  try {
    const humanAuth = await createHumanAuth({ database, allowedDomains, baseURL: env.BETTER_AUTH_URL,
      secret: env.BETTER_AUTH_SECRET, googleClientId: env.GOOGLE_CLIENT_ID, googleClientSecret: env.GOOGLE_CLIENT_SECRET });
    const dispose = humanAuth.dispose;
    let closed = false;
    return { ...humanAuth, dispose: () => {
      if (closed) return;
      closed = true; dispose(); database.close();
    } };
  } catch (error) { database.close(); throw error; }
}
