import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { betterAuth } from 'better-auth';
import { testUtils } from 'better-auth/plugins';
import { createHumanAuth } from './human-auth.js';

export const googleIssuer = 'https://accounts.google.com';
export const googleSubject = 'verified-google-123';
export const member = { nodeId: 'test-node', orgId: 'test-org', smartyId: 'sp-person', googleSubject };
export const config = { baseURL: 'http://localhost:43210', secret: 'fixture-only-secret-at-least-thirty-two-characters',
  googleClientId: 'fixture-google-client', googleClientSecret: 'fixture-google-secret', allowedDomains: ['example.test'] };
export const request = headers => ({ headers: Object.fromEntries(headers) });
export const record = () => ({ format: 1, node: { id: member.nodeId, trusted_issuers: [googleIssuer] },
  orgs: [{ id: member.orgId, placement: 'primary', members: [
    { smarty_id: member.smartyId, kind: 'person', status: 'active', role: 'owner' },
  ] }], logins: [{ issuer: googleIssuer, subject: googleSubject, smarty_id: member.smartyId }] });

// Only disposable state and official Better Auth helpers. No native capability is constructed.
export async function fixture({ configured = true, seed = true, extraEnv = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'human-member-'));
  const database = new DatabaseSync(':memory:');
  const path = join(root, 'registry.json');
  const publish = data => writeFile(path, JSON.stringify(data));
  await publish(record());
  const env = {};
  if (configured) { env.SMARTY_NODE_RECORD = path; env.SMARTY_CODE_NODE_ID = member.nodeId; }
  Object.assign(env, extraEnv);
  const human = await createHumanAuth({ ...config, database, env });
  const { adapter } = await human.auth.$context;
  const seeder = betterAuth({ ...human.auth.options,
    user: { ...human.auth.options.user, validateUserInfo: undefined }, plugins: [testUtils()] });
  const helpers = (await seeder.$context).test;
  let user, headers;
  if (seed) {
    user = await helpers.saveUser(helpers.createUser({ name: 'Person', email: 'person@example.test', emailVerified: true }));
    await adapter.create({ model: 'account', data: { userId: user.id, providerId: 'google', accountId: googleSubject,
      createdAt: new Date(), updatedAt: new Date() } });
    headers = await helpers.getAuthHeaders({ userId: user.id });
  }
  return { human, database, adapter, user, headers, publish, path, helpers,
    close: async () => { human.dispose(); database.close(); await rm(root, { recursive: true, force: true }); } };
}

export function response() {
  let status = 200, body;
  return { setHeader() {}, status(value) { status = value; return this; }, json(value) { body = value; return this; },
    result: () => ({ status, body }) };
}
