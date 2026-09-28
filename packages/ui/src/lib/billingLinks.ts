import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';

/** The signed-in person's billing links (smarty-net#136 L3): only an org owner gets any. */
const billingSchema = z.object({ owner: z.boolean(), checkout: z.string().url().optional(), portal: z.string().url().optional() });
export type Billing = z.infer<typeof billingSchema>;
const none: Billing = { owner: false };
let billing: Promise<Billing> | null = null;
/** Asked once per page; any failure reads as no links. */
export const readBilling = (): Promise<Billing> => (billing ??= runtimeFetch('/api/smarty/billing', { credentials: 'include' })
  .then(async (response) => (response.ok ? billingSchema.catch(none).parse(await response.json()) : none))
  .catch(() => none));
export const resetBillingForTests = (): void => { billing = null; };
