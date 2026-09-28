import React from 'react';
import { useStore } from 'zustand';
import { readBilling, type Billing } from '@/lib/billingLinks';
import { useDirectoryStore } from '@/sync/sync-context';

/** Smarty Code's gateway names the org's usage limit SmartyLimitError, a name OpenCode's error union does not list. */
const isUsageLimit = (name: string | undefined): boolean => name === 'SmartyLimitError';

/** Under the org's usage-limit notice: "Add credit" and "Manage plan", for the org owner only (others see no link). */
export const UsageLimitLinks: React.FC<{ sessionId?: string; messageId: string }> = ({ sessionId, messageId }) => {
    const store = useDirectoryStore();
    const isLimit = useStore(store, (state) => Boolean(sessionId)
        && (state.message[sessionId!] ?? []).some((info) => info.id === messageId
            && info.role === 'assistant' && isUsageLimit(info.error?.name)));
    const [links, setLinks] = React.useState<Billing | null>(null);
    React.useEffect(() => {
        if (!isLimit) return undefined;
        let live = true;
        void readBilling().then((value) => { if (live) setLinks(value); });
        return () => { live = false; };
    }, [isLimit]);
    return isLimit && links ? <BillingLinks links={links} /> : null;
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
