import { googleSubjectSchema } from '../billing-role/node-member.js';

/** Better Auth owns the verified Google accountId. A user ID or email is never a Google subject. */
export async function findGoogleAccountId(adapter, userId) {
  const accounts = await adapter.findMany({ model: 'account',
    where: [{ field: 'userId', value: userId }, { field: 'providerId', value: 'google' }],
    select: ['accountId'], limit: 2 });
  if (accounts.length !== 1 || !googleSubjectSchema.safeParse(accounts[0].accountId).success) return null;
  return accounts[0].accountId;
}
