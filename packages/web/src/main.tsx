import { createConfiguredWebAPIs, getDesktopRelayRestoreReady } from './runtimeConfig';

import type { RuntimeAPIs } from '@openchamber/ui/lib/api/types';
import { resolveHostedSurface, watchHostedSurfaceViewport, type HostedSurface } from '@openchamber/ui/lib/runtimeSurface';
import {
  isEmbeddedSessionChat,
  requestEmbeddedSessionRuntimeBootstrap,
} from '@openchamber/ui/components/layout/contextPanelEmbeddedChat';
import '@openchamber/ui/index.css';
import '@openchamber/ui/styles/fonts';
import '@openchamber/ui/styles/katex-css';

declare global {
  interface Window {
    __OPENCHAMBER_RUNTIME_APIS__?: RuntimeAPIs;
    __OPENCHAMBER_SURFACE__?: HostedSurface;
  }
}

const hostedSurface: HostedSurface = resolveHostedSurface();

type PrerenderingDocument = Document & {
  prerendering?: boolean;
};

const canUseServiceWorker = (): boolean => {
  if (!('serviceWorker' in navigator)) return false;
  if (!window.isSecureContext) return false;
  if (window.location.protocol !== 'http:' && window.location.protocol !== 'https:') return false;

  const documentState = document as PrerenderingDocument;
  if (documentState.prerendering || String(document.visibilityState) === 'prerender') {
    return false;
  }

  return true;
};

const runWhenDocumentCanRegisterServiceWorker = (task: () => void): void => {
  let completed = false;
  const run = () => {
    if (completed) return;
    if (canUseServiceWorker()) {
      completed = true;
      task();
    }
  };

  const afterLoad = () => {
    setTimeout(run, 0);
  };

  if (document.readyState === 'complete') {
    afterLoad();
  } else {
    window.addEventListener('load', afterLoad, { once: true });
  }

  const documentState = document as PrerenderingDocument;
  if (documentState.prerendering || String(document.visibilityState) === 'prerender') {
    document.addEventListener('visibilitychange', run, { once: true });
  }
};

const registerPwaServiceWorker = (): void => {
  runWhenDocumentCanRegisterServiceWorker(() => {
    // Registered directly, not through vite-plugin-pwa's autoUpdate registerSW: that reloads EVERY open tab as soon as
    // any tab activates a new worker, even one holding unsent text. A page reloads into a new build only through its own
    // held check on reconnect (smarty-code#713, newBuildReload.ts); a new worker just takes control (sw.ts claims clients).
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((error: unknown) => {
      console.warn('[PWA] service worker registration skipped:', error);
    });
  });
};

const unregisterDevelopmentServiceWorkers = (): void => {
  runWhenDocumentCanRegisterServiceWorker(() => {
    void navigator.serviceWorker.getRegistrations()
      .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
      .catch(() => {});
  });
};

const start = async (): Promise<void> => {
  const embeddedBootstrap = isEmbeddedSessionChat()
    ? await requestEmbeddedSessionRuntimeBootstrap()
    : null;
  window.__OPENCHAMBER_RUNTIME_APIS__ = createConfiguredWebAPIs(embeddedBootstrap);

  // Reload into the other app shell when the viewport crosses the phone
  // threshold after boot (no-op in fixed shells and with ?surface= overrides).
  watchHostedSurfaceViewport();

  if (hostedSurface === 'mobile') {
    const { renderMobileApp } = await import('@openchamber/ui/apps/renderMobileApp');
    renderMobileApp(window.__OPENCHAMBER_RUNTIME_APIS__);
    return;
  }

  // Hold the render until a desktop relay-host restore has picked its transport.
  await getDesktopRelayRestoreReady();
  await import('@openchamber/ui/main');
};

void start();

if (import.meta.hot) {
  import.meta.hot.on('openchamber:theme-updated', (theme: unknown) => {
    window.dispatchEvent(new CustomEvent('openchamber:theme-hmr', { detail: theme }));
  });
}

if (import.meta.env.PROD) {
  registerPwaServiceWorker();
} else {
  unregisterDevelopmentServiceWorkers();
}
