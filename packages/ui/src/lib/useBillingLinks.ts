import React from 'react';
import { isBillingCurrent, readBilling, type ScopedBilling } from '@/lib/billingLinks';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

const RETRY_MS = 30_000;
const RETRY_LIMIT = 3;

/**
 * The billing answer for the current runtime and sign-in while `active` (a usage-limit notice is shown), else null.
 * A runtime switch reads again; an answer from another scope is never returned. A failed lookup is asked again up to
 * RETRY_LIMIT times, RETRY_MS apart (no tight loop); a real answer is final for its scope.
 */
export function useBillingLinks(active: boolean, read: () => Promise<ScopedBilling> = readBilling, retryMs = RETRY_MS): ScopedBilling | null {
    const [links, setLinks] = React.useState<ScopedBilling | null>(null);
    const [retries, setRetries] = React.useState(0);
    const [generation, setGeneration] = React.useState(0);
    React.useEffect(() => subscribeRuntimeEndpointChanged(() => setGeneration((value) => value + 1)), []);
    const current = links !== null && isBillingCurrent(links);
    React.useEffect(() => {
        if (!active || (current && !links?.failed)) return undefined;
        const retry = Boolean(current && links?.failed);
        if (retry && retries >= RETRY_LIMIT) return undefined;
        let live = true;
        const ask = () => void read().then((value) => {
            if (!live || !isBillingCurrent(value)) return;
            setRetries((count) => (retry ? count + 1 : 0));
            setLinks(value);
        });
        const timer = retry ? setTimeout(ask, retryMs) : undefined;
        if (!retry) ask();
        return () => { live = false; clearTimeout(timer); };
    }, [active, current, links, retries, generation, read, retryMs]);
    return active && current ? links : null;
}
