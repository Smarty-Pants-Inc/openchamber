import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';

const person = z.object({ name: z.string().optional(), email: z.string().optional(), calendar: z.string().optional() });
const orgPolicy = z.object({ principals: z.array(person.extend({ name: z.string() })),
  services: z.object({ smartyCode: z.object({ members: z.array(person).optional() }).optional() }).optional() });
const settings = z.object({ SMARTY_CODE_ORG_CONFIG: z.string().optional(), SMARTY_CODE_PERSON_SCOPE: z.enum(['0', '1']).optional() });
const emailKey = z.string().trim().min(1).transform(value => value.toLowerCase());

/** Same org.json as the gateway: one exact email (else calendar), never a domain or display-name grant.
 * Broker-only; reread on issuance and use so atomic policy replacement cannot retain an old grant. */
export function createOrgMembers(env) {
  const config = settings.parse(env);
  const path = config.SMARTY_CODE_ORG_CONFIG;
  const enabled = !!path && config.SMARTY_CODE_PERSON_SCOPE !== '0';
  if (enabled && !isAbsolute(path)) throw new Error('SMARTY_CODE_ORG_CONFIG must be an absolute path');
  return { enabled, admitsEmail: async email => {
    if (!enabled) return true;
    const key = emailKey.safeParse(email);
    if (!key.success) return false;
    let file;
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
      const info = await file.stat();
      if (!info.isFile() || info.size >= 1 << 20) return false;
      const bytes = Buffer.alloc(info.size + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== info.size) return false;
      const root = orgPolicy.parse(JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')));
      const members = root.services?.smartyCode?.members ?? [];
      return [...root.principals, ...members].filter(p => (p.email ?? p.calendar)?.trim().toLowerCase() === key.data).length === 1;
    } catch { return false; }
    finally { await file?.close(); }
  } };
}
