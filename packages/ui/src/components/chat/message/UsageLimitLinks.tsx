import React from 'react';
import { useStore } from 'zustand';
import { isBillingCurrent, readBilling, type Billing, type ScopedBilling } from '@/lib/billingLinks';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useDirectoryStore, useSessionDirectory } from '@/sync/sync-context';

/** Smarty Code's gateway names the org's usage limit SmartyLimitError, a name OpenCode's error union does not list. */
const isUsageLimit = (name: string | undefined): boolean => name === 'SmartyLimitError';

/** Under the org's usage-limit notice: "Add credit" and "Manage plan", for the org owner only (others see no link). */
export const UsageLimitLinks: React.FC<{ sessionId?: string; messageId: string }> = ({ sessionId, messageId }) => {
    // The session's own directory store, as the chat reads it (the current directory can be another project).
    const store = useDirectoryStore(useSessionDirectory(sessionId));
    const isLimit = useStore(store, (state) => Boolean(sessionId)
        && (state.message[sessionId!] ?? []).some((info) => info.id === messageId
            && info.role === 'assistant' && isUsageLimit(info.error?.name)));
    const [links, setLinks] = React.useState<ScopedBilling | null>(null);
    // A runtime switch reads again; an answer from another runtime or sign-in is never shown (it is checked at render).
    const [generation, setGeneration] = React.useState(0);
    React.useEffect(() => subscribeRuntimeEndpointChanged(() => setGeneration((value) => value + 1)), []);
    const current = links !== null && isBillingCurrent(links);
    React.useEffect(() => {
        if (!isLimit || current) return undefined;
        let live = true;
        void readBilling().then((value) => { if (live && isBillingCurrent(value)) setLinks(value); });
        return () => { live = false; };
    }, [isLimit, current, generation]);
    return isLimit && links && current ? <BillingLinks links={links} /> : null;
};

/** The two links, for an owner's answer only; anything else renders nothing. */
export const BillingLinks: React.FC<{ links: Billing }> = ({ links }) => {
    if (!links.owner || !links.checkout || !links.portal) return null;
    return (
        <div className="mt-2 flex gap-4 text-sm">
            <a href={links.checkout} target="_blank" rel="noreferrer" className="underline">Add credit</a>
            <a href={links.portal} target="_blank" rel="noreferrer" className="underline">Manage plan</a>
        </div>
    );
};
