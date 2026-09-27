import { readFile, stat } from 'node:fs/promises';

const GOOGLE = 'https://accounts.google.com';

/**
 * smarty-net#117 N2: who may sign in to this Node. The Node's registry record (format 1, written by smarty-net's
 * node-registry into the Node's inbox; the launcher passes its path as SMARTY_NODE_RECORD) lists its logins (issuer,
 * subject -> smarty_id) and each placed org's members. A Google sign-in is a member when its (issuer, sub) is a login
 * there whose smarty_id is an ACTIVE member of an org on this Node, and the Node trusts that issuer. Never by email.
 * Fails closed: a missing, unreadable or invalid record admits nobody. Re-read when the file changes (size, mtime).
 */
export function createNodeMembership(path) {
  let cached = { key: '', members: new Map() };
  const load = async () => {
    const file = await stat(path).catch(() => undefined);
    if (!file) return new Map();
    const key = `${file.size}:${file.mtimeMs}:${file.ino}`;
    if (key === cached.key) return cached.members;
    const members = new Map();
    try {
      const record = JSON.parse(await readFile(path, 'utf8'));
      const trusted = new Set(Array.isArray(record?.node?.trusted_issuers) ? record.node.trusted_issuers : []);
      if (record?.format === 1 && trusted.has(GOOGLE)) {
        const active = new Set((Array.isArray(record.orgs) ? record.orgs : []).flatMap(org => (Array.isArray(org?.members) ? org.members : [])
          .filter(member => member?.status === 'active' && member?.kind === 'person').map(member => member.smarty_id)));
        for (const login of Array.isArray(record.logins) ? record.logins : []) {
          if (login?.issuer === GOOGLE && typeof login.subject === 'string' && active.has(login.smarty_id)) members.set(login.subject, login.smarty_id);
        }
      }
    } catch { /* invalid: nobody */ }
    cached = { key, members };
    return members;
  };
  /** The smarty_id of a Google account subject that is an active member of this Node, or undefined. */
  return async (googleSubject) => typeof googleSubject === 'string' && googleSubject ? (await load()).get(googleSubject) : undefined;
}
