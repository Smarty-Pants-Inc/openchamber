import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { useSessionStatus } from '@/sync/sync-context';

/**
 * Pi is waiting on a dialog in its terminal (an extension's select, confirm, input or editor). The page cannot answer
 * it and never acknowledges it: it says where the answer is needed (slice 1 L4).
 */
export const TerminalDialogNotice: React.FC<{ sessionId: string; directory?: string }> = ({ sessionId, directory }) => {
  const { t } = useI18n();
  const status = useSessionStatus(sessionId, directory);
  // The gateway keeps a session busy while its dialog is open (status.ts), so the chat's viewport shows this notice
  // even before the first message, and status polls replace it (a busy status is never skipped). An idle status with
  // a dialog breaks that contract and shows nothing rather than a notice no poll could clear.
  // ponytail: an expanded composer hides the chat, this notice included; a send then is refused with words that name
  // the dialog, so the person is still told.
  const dialog = status?.ordinary && status.type === 'busy' ? status.ordinaryDialog : null;
  if (!sessionId || !dialog) return null;
  const title = dialog.title?.trim();
  return (
    <div className="chat-message-column">
      <div role="status" className="mt-3 max-w-full break-words rounded-2xl border border-border bg-[var(--surface-elevated)] px-4 py-3 text-base leading-relaxed">
        <div className="flex items-start gap-3">
          <Icon name="terminal-box" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1 whitespace-pre-wrap break-words text-foreground">
            {title ? t('chat.terminalDialog.waitingTitled', { title }) : t('chat.terminalDialog.waiting')}
          </div>
        </div>
      </div>
    </div>
  );
};
