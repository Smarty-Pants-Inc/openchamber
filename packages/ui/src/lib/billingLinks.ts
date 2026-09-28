import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { captureRuntimeRequestScope, isRuntimeRequestScopeCurrent, type RuntimeRequestScope } from '@/lib/runtime-switch';

/** The signed-in person's billing links (smarty-net#136 L3): only an org owner gets any. */
const billingSchema = z.object({ owner: z.boolean(), checkout: z.string().url().optional(), portal: z.string().url().optional() });
export type Billing = z.infer<typeof billingSchema>;
/** An answer is valid only for the runtime and sign-in it was read under (another Node, or another person, may differ). */
export type ScopedBilling = Billing & { scope: RuntimeRequestScope };
const none: Billing = { owner: false };
let cached: Promise<ScopedBilling> | null = null;
let cachedScope: RuntimeRequestScope | null = null;

export const isBillingCurrent = (answer: ScopedBilling): boolean => isRuntimeRequestScopeCurrent(answer.scope);

/** Asked once per runtime and sign-in; a switch starts a new read. A failed or stale read is never kept. */
export const readBilling = (fetcher: typeof runtimeFetch = runtimeFetch): Promise<ScopedBilling> => {
    if (cached && cachedScope && isRuntimeRequestScopeCurrent(cachedScope)) return cached;
    const scope = captureRuntimeRequestScope();
    const read = fetcher('/api/smarty/billing', { credentials: 'include' })
        .then(async (response) => ({ ...(response.ok ? billingSchema.catch(none).parse(await response.json()) : none), scope }))
        .catch(() => { if (cached === read) cached = null; return { ...none, scope }; });
    cached = read; cachedScope = scope;
    return read;
};
export const resetBillingForTests = (): void => { cached = null; cachedScope = null; };
