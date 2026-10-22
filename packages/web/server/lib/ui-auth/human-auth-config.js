import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { createHumanAuth } from './human-auth.js';
import { createHumanAudience } from './human-audience.js';

const BROKER_KEYS = ['SMARTY_HUMAN_AUTH_BROKER_ISSUER', 'SMARTY_HUMAN_AUTH_BROKER_CLIENT_ID',
  'SMARTY_HUMAN_AUTH_BROKER_CLIENT_SECRET_FILE', 'SMARTY_HUMAN_AUTH_BROKER_CONNECTOR'];

/** Ordinary injected environment only; credential delivery and activation belong to the caller. */
export async function createConfiguredHumanAuth(env) {
  const mode = env.OPENCHAMBER_HUMAN_AUTH;
  // A present Node pin (even empty) forbids legacy admission before any database/startup effects.
  if (env.SMARTY_CODE_NODE_ID !== undefined && mode !== 'google') {
    throw new Error('SMARTY_CODE_NODE_ID requires OPENCHAMBER_HUMAN_AUTH=google');
  }
  if (mode === undefined || mode === '' || mode === 'off') return null;
  if (mode !== 'google') throw new Error('OPENCHAMBER_HUMAN_AUTH must be google or off');
  // Broker mode replaces the org's own Google client; the two never mix and nothing is faked.
  const brokered = env.SMARTY_HUMAN_AUTH_BROKER_ISSUER !== undefined;
  if (brokered && (env.GOOGLE_CLIENT_ID !== undefined || env.GOOGLE_CLIENT_SECRET !== undefined)) {
    throw new Error('Human authentication uses either the sign-in broker or a Google client, not both');
  }
  for (const key of ['OPENCHAMBER_HUMAN_AUTH_DB', 'BETTER_AUTH_URL', 'BETTER_AUTH_SECRET', 'SMARTY_HUMAN_AUTH_ALLOWED_DOMAINS',
    ...(brokered ? BROKER_KEYS : ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'])]) {
    if (typeof env[key] !== 'string' || !env[key].trim()) throw new Error(`Human authentication requires ${key}`);
  }
  // The caller projects the per-org credential as a file; never hydrate it into the environment.
  const broker = brokered ? { issuer: env.SMARTY_HUMAN_AUTH_BROKER_ISSUER, clientId: env.SMARTY_HUMAN_AUTH_BROKER_CLIENT_ID,
    clientSecret: await readBrokerSecret(env.SMARTY_HUMAN_AUTH_BROKER_CLIENT_SECRET_FILE),
    connector: env.SMARTY_HUMAN_AUTH_BROKER_CONNECTOR } : null;
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
    const humanAuth = await createHumanAuth({ database, allowedDomains, env, baseURL: env.BETTER_AUTH_URL, broker,
      secret: env.BETTER_AUTH_SECRET, googleClientId: env.GOOGLE_CLIENT_ID, googleClientSecret: env.GOOGLE_CLIENT_SECRET });
    const dispose = humanAuth.dispose;
    let closed = false;
    return { ...humanAuth, dispose: () => {
      if (closed) return;
      closed = true; dispose(); database.close();
    } };
  } catch (error) { database.close(); throw error; }
}

async function readBrokerSecret(path) {
  if (!isAbsolute(path)) throw new Error('Broker client secret file must be an absolute path');
  let file;
  try {
    // Projected Kubernetes credentials can be symlinks; validate the opened target, not its link.
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile() || info.size < 1 || info.size > 16384) throw new Error();
    const bytes = Buffer.alloc(info.size + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const secret = bytes.subarray(0, bytesRead).toString('utf8').trim();
    if (bytesRead !== info.size || !secret) throw new Error();
    return secret;
  } catch { throw new Error('Human authentication broker client secret file is unreadable or invalid'); }
  finally { await file?.close(); }
}
