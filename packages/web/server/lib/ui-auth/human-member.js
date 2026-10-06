import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { resolveNodeMember, registryIdSchema } from '../billing-role/node-member.js';
import { findGoogleAccountId } from './google-account.js';

const configSchema = z.object({ nodeId: registryIdSchema, record: z.string().refine(isAbsolute),
  orgId: registryIdSchema.optional() });

/** Record presence alone remains billing-only. SMARTY_CODE_NODE_ID explicitly requires Node admission. */
export function createHumanMemberBinding(env) {
  const nodeId = env.SMARTY_CODE_NODE_ID;
  const required = nodeId !== undefined;
  const record = env.SMARTY_NODE_RECORD;
  const orgId = env.SMARTY_NODE_ORG_ID;
  const admitted = new WeakMap();
  const lookup = async (adapter, userId) => {
    if (!required) return null;
    const config = configSchema.safeParse({ nodeId, record, orgId });
    if (!config.success) throw new Error('Node member admission requires valid Node configuration and an absolute record path');
    const subject = await findGoogleAccountId(adapter, userId);
    if (!subject) return null;
    return resolveNodeMember(JSON.parse(await readFile(config.data.record, 'utf8')), subject, config.data)?.member ?? null;
  };
  return {
    required, lookup,
    admit: async (adapter, session) => {
      // Never reuse an old binding if a caller rechecks the same library object.
      admitted.delete(session);
      const member = await lookup(adapter, session.user.id);
      if (required && !member) return false;
      if (member) admitted.set(session, member);
      return true;
    },
    forwardedMember: session => {
      const member = admitted.get(session);
      return member ? { ...member } : null;
    },
  };
}
