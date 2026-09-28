import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { captureRuntimeRequestScope, isRuntimeRequestScopeCurrent, type RuntimeRequestScope } from '@/lib/runtime-switch';

/** The signed-in person's billing links (smarty-net#136 L3): only an org owner gets any. */
const billingSchema = z.object({ owner: z.boolean(), checkout: z.string().url().optional(), portal: z.string().url().optional() });
export type Billing = z.infer<typeof billingSchema>;
/** An answer is valid only for the runtime and sign-in it was read under (another Node, or another person, may differ).
 * `failed`: the lookup did not answer (an error status, a malformed answer or no connection): no links now, and not a
 * "not the owner" answer, so it is never kept and the notice may ask again later. */
export type ScopedBilling = Billing & { scope: RuntimeRequestScope; failed?: true };
const none: Billing = { owner: false };
let cached: Promise<ScopedBilling> | null = null;
let cachedScope: RuntimeRequestScope | null = null;

export const isBillingCurrent = (answer: ScopedBilling): boolean => isRuntimeRequestScopeCurrent(answer.scope);

/** Asked once per runtime and sign-in; a switch starts a new read. Only a real answer is kept; a failure is not. */
export const readBilling = (fetcher: typeof runtimeFetch = runtimeFetch): Promise<ScopedBilling> => {
    if (cached && cachedScope && isRuntimeRequestScopeCurrent(cachedScope)) return cached;
    const scope = captureRuntimeRequestScope();
    const failed: ScopedBilling = { ...none, scope, failed: true };
    const read = fetcher('/api/smarty/billing', { credentials: 'include' })
        .then(async (response) => {
            const answer = response.ok ? billingSchema.safeParse(await response.json()) : null;
            return answer?.success ? { ...answer.data, scope } : failed;
        })
        .catch(() => failed)
        .then((result) => { if (result.failed && cached === read) cached = null; return result; });
    cached = read; cachedScope = scope;
    return read;
};
export const resetBillingForTests = (): void => { cached = null; cachedScope = null; };
