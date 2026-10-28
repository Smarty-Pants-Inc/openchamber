import { AsyncLocalStorage } from 'node:async_hooks';
import { getAdapter } from 'better-auth/db/adapter';
import { getOAuthState } from 'better-auth/api';

class RefusedCallback extends Error {
  constructor(response) { super('Broker callback refused'); this.response = response; }
}
const refusal = () => new RefusedCallback(Response.json({ code: 'account_not_allowed',
  message: 'This account is not allowed to use this instance' }, { status: 403 }));

/** Keep Better Auth's user/account/session writes in the same SQLite transaction.
 * Its handler installs its own adapter context, so forward that adapter into our
 * request-local transaction, including the library's nested provisioning calls. */
export async function createBrokerProvisioning(options, orgMembers) {
  const scope = new AsyncLocalStorage();
  const adapter = await getAdapter(options);
  if (!adapter.options?.adapterConfig.transaction) throw new Error('Broker sign-in requires a transactional database');
  return {
    database: () => new Proxy(adapter, {
      get(target, key) {
        // The pinned Better Auth factory exposes closure-based adapter methods.
        return (scope.getStore()?.adapter ?? target)[key];
      },
    }),
    async admit(user, subject) {
      const state = scope.getStore();
      if (!state || state.admission) return false;
      const snapshot = await orgMembers.snapshot(user.email);
      if (!snapshot) return false;
      const flow = await getOAuthState();
      state.admission = { snapshot, subject, destinations: [flow?.callbackURL, flow?.newUserURL] };
      return true;
    },
    admitsUser(user) {
      const admission = scope.getStore()?.admission;
      return !!admission && user?.email?.trim().toLowerCase() === admission.snapshot.email;
    },
    admitsAccount(account) {
      const admission = scope.getStore()?.admission;
      return !!admission && account.providerId === 'google' && account.accountId === admission.subject;
    },
    session(session) {
      const state = scope.getStore();
      if (state?.admission) state.sessionToken = session.token;
    },
    wrap(handler, sessionCookieName) {
      return async request => {
        // Better Auth accepts both callback methods. POST redirects to GET before provisioning.
        if (!new URL(request.url).pathname.endsWith('/api/auth/callback/google')) return handler(request);
        try {
          return await adapter.transaction(trx => scope.run({ adapter: trx }, async () => {
            const response = await handler(request);
            const state = scope.getStore();
            // A refusal may be a redirect rather than a thrown exception. Never commit
            // partial provisioning or token updates merely because HTTP completed.
            const issued = response.headers.getSetCookie().some(cookie =>
              cookie.startsWith(`${sessionCookieName}=`) && !cookie.includes('Max-Age=0'));
            if (!state.sessionToken || !issued || response.status !== 302
              || !state.admission.destinations.includes(response.headers.get('location'))) {
              // A failed response must not leave a cookie for a rolled-back session.
              const headers = new Headers(response.headers);
              headers.delete('set-cookie');
              for (const cookie of response.headers.getSetCookie()) {
                if (!cookie.startsWith(`${sessionCookieName}=`) || cookie.includes('Max-Age=0')) headers.append('set-cookie', cookie);
              }
              throw new RefusedCallback(new Response(response.body, { status: response.status, statusText: response.statusText, headers }));
            }
            const session = await trx.findOne({ model: 'session', where: [{ field: 'token', value: state.sessionToken }] });
            if (!session) throw refusal();
            // In 1.7.5 an account create hook returning false can otherwise be
            // followed by a successful session. Require the admitted binding too.
            const account = await trx.findOne({ model: 'account', where: [
              { field: 'userId', value: session.userId }, { field: 'providerId', value: 'google' },
              { field: 'accountId', value: state.admission.subject },
            ] });
            if (!account) throw refusal();
            // One admission decision, then a publication-freshness check. A replaced
            // or unreadable org file invalidates the snapshot, not a second grant.
            if (!await orgMembers.unchanged(state.admission.snapshot)) throw refusal();
            return response;
          }));
        } catch (error) {
          if (error instanceof RefusedCallback) return error.response;
          throw error;
        }
      };
    },
  };
}
