import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useSteerOutcomes } from '@/sync/steer-outcomes';

/** Every steered message of this session that was not sent, with its text, until its sender dismisses it (G5). */
export const SteerOutcomeNotices: React.FC<{ sessionId: string }> = ({ sessionId }) => {
  const { t } = useI18n();
  const items = useSteerOutcomes(state => state.items);
  const dismiss = useSteerOutcomes(state => state.dismiss);
  const runtimeKey = getRuntimeKey();
  const shown = React.useMemo(() => items.filter(item => item.sessionID === sessionId && item.runtimeKey === runtimeKey),
    [items, runtimeKey, sessionId]);
  if (!sessionId || shown.length === 0) return null;
  return (
    <div className="chat-message-column">
      {shown.map(item => (
        <div
          key={item.messageID}
          role="status"
          className="mt-3 max-w-full break-words rounded-2xl border border-[var(--status-error-border)] bg-[var(--status-error-background)] px-4 py-3 text-base leading-relaxed"
        >
          <div className="flex items-start gap-3">
            <Icon name="error-warning" className="mt-0.5 size-4 shrink-0 text-[var(--status-error)]" />
            <div className="min-w-0 flex-1 whitespace-pre-wrap break-words text-foreground">
              {t(item.outcome === 'not-delivered' ? 'chat.coSteer.notDelivered' : 'chat.coSteer.unconfirmed', { text: item.text })}
            </div>
            <button
              type="button"
              className="shrink-0 text-muted-foreground hover:text-foreground"
              aria-label={t('chat.coSteer.dismiss')}
              title={t('chat.coSteer.dismiss')}
              onClick={() => dismiss(item.runtimeKey, item.messageID)}
            >
              <Icon name="close" className="size-4" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
};
