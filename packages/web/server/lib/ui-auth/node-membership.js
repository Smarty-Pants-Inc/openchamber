import { readFile, stat } from 'node:fs/promises';

const GOOGLE = 'https://accounts.google.com';
// The record contract (format 1, smarty-code#380): every field known, every required one present and of its type.
const TOP = new Set(['format', 'revision', 'generated_at', 'node', 'orgs', 'logins']);
const NODE = new Set(['id', 'name', 'host', 'status', 'node_root', 'project_roots', 'herdr', 'pi_agent_dir', 'origin', 'path_base',
  'trusted_issuers', 'credentials']);
const ORG = new Set(['id', 'name', 'github_owner', 'placement', 'members']);
const MEMBER = new Set(['smarty_id', 'name', 'kind', 'role', 'sponsor', 'status']);
const LOGIN = new Set(['issuer', 'subject', 'email_display', 'smarty_id']);
const KINDS = new Set(['person', 'personal_agent', 'org_agent']), STATUSES = new Set(['active', 'suspended']);
const object = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.has(key));
const id = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256;

/** The record's Google members (subject -> smarty_id), or undefined when any part of it is invalid (then: nobody). */
export function nodeMembers(record) {
  if (!object(record, TOP) || record.format !== 1 || !Number.isSafeInteger(record.revision) || !object(record.node, NODE)
    || !id(record.node.id) || !Array.isArray(record.node.trusted_issuers) || !record.node.trusted_issuers.every(id)
    || !Array.isArray(record.orgs) || !Array.isArray(record.logins)) return undefined;
  const active = new Set();
  for (const org of record.orgs) {
    if (!object(org, ORG) || !id(org.id) || !Array.isArray(org.members)) return undefined;
    for (const member of org.members) {
      if (!object(member, MEMBER) || !id(member.smarty_id) || !KINDS.has(member.kind) || !STATUSES.has(member.status)) return undefined;
      if (member.status === 'active' && member.kind === 'person') active.add(member.smarty_id);
    }
  }
  const members = new Map();
  for (const login of record.logins) {
    if (!object(login, LOGIN) || !id(login.issuer) || !id(login.subject) || !id(login.smarty_id)) return undefined;
    if (login.issuer === GOOGLE && record.node.trusted_issuers.includes(GOOGLE) && active.has(login.smarty_id)) members.set(login.subject, login.smarty_id);
  }
  return members;
}

/**
 * smarty-net#117 N2: who may sign in to this Node. The Node's registry record (format 1, written by smarty-net's
 * node-registry into the Node's inbox; the launcher passes its path as SMARTY_NODE_RECORD) lists its logins (issuer,
 * subject -> smarty_id) and each placed org's members. A Google sign-in is a member when its (issuer, sub) is a login
 * there whose smarty_id is an ACTIVE person member of an org on this Node, and the Node trusts that issuer. Never by email.
 * Fails closed: a missing, unreadable or invalid record (any unknown or missing field) admits nobody. Re-read when the
 * file changes (size, mtime, inode).
 */
export function createNodeMembership(path) {
  let cached = { key: '', members: new Map() };
  const load = async () => {
    const file = await stat(path).catch(() => undefined);
    if (!file) return new Map();
    const key = `${file.size}:${file.mtimeMs}:${file.ino}`;
    if (key === cached.key) return cached.members;
    let members;
    try { members = nodeMembers(JSON.parse(await readFile(path, 'utf8'))); } catch { members = undefined; }
    cached = { key, members: members ?? new Map() };
    return cached.members;
  };
  /** The smarty_id of a Google account subject that is an active member of this Node, or undefined. */
  return async (googleSubject) => typeof googleSubject === 'string' && googleSubject ? (await load()).get(googleSubject) : undefined;
}
