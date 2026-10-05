import { z } from 'zod';

const GOOGLE_ISSUER = 'https://accounts.google.com';
export const registryIdSchema = z.string().max(63).regex(/^[a-z0-9][a-z0-9_-]{0,62}$/).refine(id => id.trim() === id);
export const googleSubjectSchema = z.string().max(256).regex(/^[A-Za-z0-9_-]{1,256}$/)
  .refine(subject => subject.trim() === subject);
const recordSchema = z.object({
  format: z.literal(1),
  node: z.object({ id: registryIdSchema, trusted_issuers: z.array(z.string()) }),
  orgs: z.array(z.object({ id: registryIdSchema, placement: z.string().optional(), members: z.array(z.object({
    smarty_id: registryIdSchema, kind: z.string().optional(), status: z.string(), role: z.string().optional(),
  })) })),
  logins: z.array(z.object({ issuer: z.string(), subject: z.string().min(1), smarty_id: registryIdSchema })),
});

/** Record B is the only member authority. Return one active person, never a guessed identity. */
export function resolveNodeMember(record, googleSubject, { orgId, nodeId } = {}) {
  if (!googleSubjectSchema.safeParse(googleSubject).success) return null;
  const parsed = recordSchema.safeParse(record);
  if (!parsed.success) throw new Error('Unsupported Node member record');
  const data = parsed.data;
  if ((nodeId !== undefined && data.node.id !== nodeId) || !data.node.trusted_issuers.includes(GOOGLE_ISSUER)) return null;
  const orgs = data.orgs.filter(org => orgId ? org.id === orgId : org.placement === 'primary');
  if (orgs.length !== 1 || data.orgs.filter(org => org.id === orgs[0].id).length !== 1) return null;
  const logins = data.logins.filter(login => login.issuer === GOOGLE_ISSUER && login.subject === googleSubject);
  if (logins.length !== 1) return null;
  const people = orgs[0].members.filter(person => person.smarty_id === logins[0].smarty_id);
  if (people.length !== 1 || people[0].kind !== 'person' || people[0].status !== 'active') return null;
  return { member: { nodeId: data.node.id, orgId: orgs[0].id, smartyId: people[0].smarty_id, googleSubject },
    role: people[0].role };
}
