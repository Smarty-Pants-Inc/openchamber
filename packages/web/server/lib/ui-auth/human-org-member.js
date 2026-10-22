import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';

const person = z.object({ name: z.string().optional(), email: z.string().optional(), calendar: z.string().optional() });
const orgPolicy = z.object({ principals: z.array(person.extend({ name: z.string() })),
  services: z.object({ smartyCode: z.object({ members: z.array(person).optional() }).optional() }).optional() });
const settings = z.object({ SMARTY_CODE_ORG_CONFIG: z.string().optional(), SMARTY_CODE_PERSON_SCOPE: z.enum(['0', '1']).optional() });
const emailKey = z.string().trim().min(1).transform(value => value.toLowerCase());

/** Same org.json as the gateway: one exact email (else calendar), never a domain or display-name grant.
 * Broker-only; callbacks carry one snapshot and session use always reads the current publication. */
export function createOrgMembers(env) {
  const config = settings.parse(env);
  const path = config.SMARTY_CODE_ORG_CONFIG;
  const enabled = !!path && config.SMARTY_CODE_PERSON_SCOPE !== '0';
  if (enabled && !isAbsolute(path)) throw new Error('SMARTY_CODE_ORG_CONFIG must be an absolute path');
  const read = async () => {
    let file;
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
      const info = await file.stat();
      if (!info.isFile() || info.size >= 1 << 20) return null;
      const bytes = Buffer.alloc(info.size + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== info.size) return null;
      const content = bytes.subarray(0, bytesRead);
      return { root: orgPolicy.parse(JSON.parse(content.toString('utf8'))),
        fingerprint: createHash('sha256').update(content).digest('hex') };
    } catch { return null; }
    finally { await file?.close(); }
  };
  const snapshot = async email => {
    const key = emailKey.safeParse(email);
    if (!key.success) return null;
    const publication = await read();
    if (!publication) return null;
    const members = publication.root.services?.smartyCode?.members ?? [];
    if ([...publication.root.principals, ...members].filter(p => (p.email ?? p.calendar)?.trim().toLowerCase() === key.data).length !== 1) return null;
    return { email: key.data, fingerprint: publication.fingerprint };
  };
  return { enabled, snapshot,
    unchanged: async admission => (await read())?.fingerprint === admission.fingerprint,
    admitsEmail: async email => !enabled || !!await snapshot(email),
  };
}
