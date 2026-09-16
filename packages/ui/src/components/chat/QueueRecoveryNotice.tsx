import React from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { getMessageQueueKey, useMessageQueueStore, type MessageQueueTarget, type QueuedMessage } from '@/stores/messageQueueStore';

const EMPTY: QueuedMessage[] = [];

/** Recovery reads never transfer custody or offer a Send action. */
export function QueueRecoveryNotice({ target }: { target: MessageQueueTarget | null }) {
    const { t } = useI18n();
    const key = target ? getMessageQueueKey(target) : null;
    const messages = useMessageQueueStore(state => key ? state.recoveryMessages[key] ?? EMPTY : EMPTY);
    const [removing, setRemoving] = React.useState<{ target: MessageQueueTarget; id: string } | null>(null);
    const [busy, setBusy] = React.useState(false);

    const download = async (id: string) => {
        if (!target || busy) return;
        setBusy(true);
        try {
            const message = await useMessageQueueStore.getState().recoverMessage(target, id);
            const payload = { ...message, attachments: message.attachments?.map(({ file, ...attachment }) => { void file; return attachment; }) };
            const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
            const link = document.createElement('a');
            link.href = url;
            link.download = 'queued-message-recovery.json';
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 0);
        } catch { toast.error(t('chat.queuedMessage.toast.takeFailed')); }
        finally { setBusy(false); }
    };

    const forget = async () => {
        if (!removing || busy) return;
        setBusy(true);
        try {
            await useMessageQueueStore.getState().forgetRecovery(removing.target, removing.id);
            setRemoving(null);
        } catch { toast.error(t('chat.queuedMessage.toast.takeFailed')); }
        finally { setBusy(false); }
    };

    if (!target || !messages.length) return null;
    return <section className="mb-2 rounded-lg border border-border bg-[var(--surface-elevated)] p-3" aria-label={t('chat.queuedMessage.recoveryTitle')}>
        <p className="typography-ui-label font-medium">{t('chat.queuedMessage.recoveryTitle')}</p>
        <p className="typography-ui-label text-muted-foreground">{t('chat.queuedMessage.recoveryDescription')}</p>
        <ul className="mt-2 flex max-h-48 flex-col gap-2 overflow-y-auto">
            {messages.map(message => <li key={message.id} className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 truncate typography-ui-label">{message.content || t('chat.queuedMessage.empty')}</span>
                <Button size="xs" variant="secondary" disabled={busy} onClick={() => { void download(message.id); }}>{t('chat.queuedMessage.recoverPayload')}</Button>
                <Button size="xs" variant="ghost" disabled={busy} onClick={() => setRemoving({ target, id: message.id })}>{t('chat.queuedMessage.forgetReviewed')}</Button>
            </li>)}
        </ul>
        <Dialog open={removing !== null} onOpenChange={open => { if (!open && !busy) setRemoving(null); }}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t('chat.queuedMessage.forgetReviewed')}</DialogTitle>
                    <DialogDescription>{t('chat.queuedMessage.forgetConfirm')}</DialogDescription>
                </DialogHeader>
                <DialogFooter>
                    <Button variant="ghost" disabled={busy} onClick={() => setRemoving(null)}>{t('chat.appLink.confirm.cancel')}</Button>
                    <Button variant="destructive" disabled={busy} onClick={() => { void forget(); }}>{t('chat.queuedMessage.forgetReviewed')}</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    </section>;
}
