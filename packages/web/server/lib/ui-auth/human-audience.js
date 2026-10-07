import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { z } from 'zod';

const domainPattern = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/;
const maxListBytes = 1024 * 1024;
const pathSchema = z.string().refine(isAbsolute);
const listSchema = z.strictObject({ emails: z.array(z.string().refine(validEmail)) });

/** Configuration is an explicit access policy, never a Google account-selection hint. */
export function createHumanAudience(domains, { allowedEmailsFile, log = message => console.warn(message) } = {}) {
  if (!Array.isArray(domains) || domains.length === 0) {
    throw new Error('Human authentication requires an allowed email domain');
  }
  const allowed = new Set(domains.map((domain) => {
    if (typeof domain !== 'string' || domain !== domain.trim() || !domainPattern.test(domain.toLowerCase())) {
      throw new Error('Invalid allowed email domain');
    }
    return domain.toLowerCase();
  }));
  const members = allowedEmailsFile === undefined ? null : createMembersList(allowedEmailsFile, log);
  const admits = (user) => {
    if (user?.emailVerified !== true || typeof user.email !== 'string') return false;
    const email = user.email;
    if (!validEmail(email)) return false;
    if (!allowed.has(email.split('@')[1].toLowerCase())) return false;
    if (!members) return true;
    // smarty-code#1391: the list narrows the domain; an unreadable or invalid list admits nobody.
    return members()?.has(email.toLowerCase()) === true;
  };
  // The connection lifetime sweeps open streams only when admission can change without a session change.
  admits.revocable = members !== null;
  return admits;
}

function validEmail(email) {
  if (email !== email.trim() || /[\s\u0000-\u001f\u007f]/u.test(email)) return false;
  const parts = email.split('@');
  return parts.length === 2 && parts[0].length > 0 && parts[1].length > 0;
}

/**
 * Reads `{"emails": [...]}` from a private regular file owned by this process's user, re-reading it when its
 * identity or timestamps change, so revoking a person needs no restart. Returns the lowercase set, or null (deny all).
 */
function createMembersList(path, log) {
  if (!pathSchema.safeParse(path).success) {
    throw new Error('SMARTY_HUMAN_AUTH_ALLOWED_EMAILS_FILE must be an absolute path');
  }
  const uid = process.getuid?.();
  let cached = { key: null, emails: null }, lastProblem = null;
  const problem = (message) => {
    cached = { key: null, emails: null };
    // Log each distinct problem once, not on every request; never log list contents.
    if (message !== lastProblem) log(`[human-auth] members list ${path} denies all sign-ins: ${message}`);
    lastProblem = message;
    return null;
  };
  return () => {
    let fd;
    try {
      const parent = lstatSync(dirname(path));
      if (!parent.isDirectory() || (parent.mode & 0o022) || (parent.uid !== uid && parent.uid !== 0)) {
        return problem('its directory is writable by others or not owned by the service user');
      }
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd, { bigint: true });
      if (!stat.isFile() || (stat.mode & 0o077n) || (uid !== undefined && stat.uid !== BigInt(uid))) {
        return problem('it must be a private (0600) regular file owned by the service user');
      }
      if (stat.size > maxListBytes) return problem('it is too large');
      const key = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
      if (cached.key === key) return cached.emails;
      const emails = parseMembers(readFileSync(fd, 'utf8'));
      if (!emails) return problem('it must be JSON {"emails": ["person@domain", ...]}');
      cached = { key, emails };
      if (lastProblem !== null) log(`[human-auth] members list ${path} is valid again`);
      lastProblem = null;
      return emails;
    } catch (error) {
      return problem(error?.code === 'ELOOP' ? 'it is a symlink' : `it cannot be read (${error?.code ?? 'invalid'})`);
    } finally { if (fd !== undefined) closeSync(fd); }
  };
}

function parseMembers(text) {
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  const list = listSchema.safeParse(value);
  return list.success ? new Set(list.data.emails.map(email => email.toLowerCase())) : null;
}
