import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { useAuthSessionStore } from '@/lib/runtime-auth-expiry';
import { useProjectsStore } from '@/stores/useProjectsStore';

/**
 * Non-blocking notice that the OpenChamber session expired mid-work. It never
 * takes the screen on its own: work stays visible and interactive, and only
 * the explicit "Log in" click hands control to the session gate's full login
 * flow (password, passkey, desktop shell — all already there).
 * The same authenticated placement also reports managed catalog availability;
 * auth expiry takes priority. Catalog notices never mutate state or offer retries.
 */
export const AuthExpiredBanner: React.FC = () => {
  const { t } = useI18n();
  const authState = useAuthSessionStore((store) => store.state);
  const markReauthenticating = useAuthSessionStore((store) => store.markReauthenticating);

  const catalogMessage = useProjectsStore((store) => {
    if (!store.managedCatalogAdmitted) return null;
    if (store.managedCatalogStatus === 'unavailable') return 'sessions.catalog.unavailable' as const;
    if (store.managedCatalogStatus === 'ready' && store.managedProjects?.length === 0) {
      return 'sessions.catalog.empty' as const;
    }
    return null;
  });
  const expired = authState === 'expired';
  const messageKey = expired ? 'sessionAuth.expired.banner' : catalogMessage;
  if (!messageKey || (!expired && authState !== 'ok')) return null;

  return (
    // Below the header on purpose: the header row can be a window-drag region
    // on desktop, where nothing under the cursor is clickable.
    <div
      className="pointer-events-none fixed inset-x-0 z-[200] flex justify-center px-4"
      style={{ top: 'calc(var(--oc-header-height, 56px) + 8px)' }}
    >
      <div
        role={expired ? 'alert' : 'status'}
        className={`oc-glass-popover oc-glass-floating flex items-center gap-3 rounded-lg px-3 py-2 ${expired ? 'pointer-events-auto' : 'pointer-events-none max-w-xl'}`}
      >
        {expired && <Icon name="lock" className="size-4 flex-shrink-0" style={{ color: 'var(--status-error)' }} />}
        <span className="min-w-0 whitespace-normal typography-ui-label text-foreground">{t(messageKey)}</span>
        {expired && <Button size="xs" variant="outline" onClick={markReauthenticating} className="normal-case">
          {t('sessionAuth.expired.loginAction')}
        </Button>}
      </div>
    </div>
  );
};
