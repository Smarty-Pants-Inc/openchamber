import React from 'react';
import { toast } from '@/components/ui';
import { isWebRuntime } from '@/lib/desktop';
import { usePwaDetection } from '@/hooks/usePwaDetection';
import { useI18n } from '@/lib/i18n';
import { getSafeStorage } from '@/stores/utils/safeStorage';
import { shouldShowPwaInstallToast } from '@/components/update/openCodeUpdateDedup';

type InstallPromptOutcome = 'accepted' | 'dismissed';

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: InstallPromptOutcome }>;
};

// Shown, dismissed or installed: the toast never returns in this browser. The key keeps its old name so an
// earlier dismissal still counts. Written immediately (not deferred) so a quick reload cannot lose it.
const INSTALL_TOAST_SEEN_KEY = 'pwa-install-toast-dismissed';
const markInstallToastSeen = () => getSafeStorage().setItem(INSTALL_TOAST_SEEN_KEY, 'true');

export const usePwaInstallPrompt = () => {
  const { browserTab } = usePwaDetection();
  const { t } = useI18n();
  const tRef = React.useRef(t);

  React.useEffect(() => {
    tRef.current = t;
  }, [t]);

  React.useEffect(() => {
    if (typeof window === 'undefined' || !isWebRuntime() || !browserTab) {
      return;
    }

    let deferredPrompt: BeforeInstallPromptEvent | null = null;
    let installToastId: string | number | null = null;

    const dismissInstallToast = () => {
      if (installToastId === null) {
        return;
      }
      toast.dismiss(installToastId);
      installToastId = null;
    };

    const triggerInstall = async () => {
      if (!deferredPrompt) {
        return;
      }

      const promptEvent = deferredPrompt;
      deferredPrompt = null;
      dismissInstallToast();

      await promptEvent.prompt();
      const { outcome } = await promptEvent.userChoice;
      if (outcome === 'accepted') {
        toast.success(tRef.current('pwa.installPrompt.started'));
      }
    };

    const onBeforeInstallPrompt = (event: Event) => {
      const installEvent = event as BeforeInstallPromptEvent;
      if (typeof installEvent.prompt !== 'function') {
        return;
      }

      installEvent.preventDefault();
      deferredPrompt = installEvent;

      const decision = shouldShowPwaInstallToast({
        seen: getSafeStorage().getItem(INSTALL_TOAST_SEEN_KEY),
        hasActiveToast: installToastId !== null,
      });
      if (!decision) {
        return;
      }

      markInstallToastSeen();

      installToastId = toast.info(tRef.current('pwa.installPrompt.description'), {
        duration: Infinity,
        action: {
          label: tRef.current('pwa.installPrompt.action'),
          onClick: () => {
            void triggerInstall();
          },
        },
        cancel: {
          label: tRef.current('pwa.installPrompt.dismiss'),
          onClick: () => {
            markInstallToastSeen();
            dismissInstallToast();
          },
        },
      });
    };

    const onAppInstalled = () => {
      markInstallToastSeen();
      deferredPrompt = null;
      dismissInstallToast();
      toast.success(tRef.current('pwa.installPrompt.installed'));
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt as EventListener);
    window.addEventListener('appinstalled', onAppInstalled);

    return () => {
      dismissInstallToast();
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt as EventListener);
      window.removeEventListener('appinstalled', onAppInstalled);
    };
  }, [browserTab]);
};
