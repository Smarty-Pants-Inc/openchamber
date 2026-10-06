import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChatInput } from '@/components/chat/ChatInput';
import { I18nProvider } from '@/lib/i18n';
import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';
import { RuntimeSyncProvider } from '@/sync/sync-context';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { createWebAPIs } from '../../packages/web/src/api';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { browserDisplayName } from '@/lib/messages/displayName';
import { opencodeClient } from '@/lib/opencode/client';
import { setOptimisticRefs } from '@/sync/session-actions';
import { useSync } from '@/sync/use-sync';
import '@/index.css';

const directory = '/attachment-proof';
const apis = createWebAPIs();
const mobile = new URLSearchParams(window.location.search).has('mobile');
browserDisplayName.useUnnamedForTab();
useDirectoryStore.setState({ currentDirectory: directory });
useProjectsStore.setState({ projects: [{ id: 'proof', path: directory }], activeProjectId: 'proof', managedCatalogStatus: 'stock' });
useUIStore.setState({ isMobile: mobile, persistChatDraft: false });
useSessionUIStore.setState({ currentSessionId: 'proof-session', currentSessionDirectory: directory, newSessionDraft: { ...useSessionUIStore.getState().newSessionDraft, open: false } });
await useConfigStore.getState().activateDirectory(directory);
useConfigStore.setState({ currentProviderId: 'proof', currentModelId: 'text', currentAgentName: 'build', isConnected: true });
opencodeClient.setDirectory(directory);

export function ProofComposer() {
  const sync = useSync();
  React.useEffect(() => {
    setOptimisticRefs(sync.optimistic.add, sync.optimistic.remove, sync.optimistic.confirm);
  }, [sync.optimistic.add, sync.optimistic.remove, sync.optimistic.confirm]);
  return <ChatInput />;
}

export function Fixture() {
  return <I18nProvider><ThemeSystemProvider><RuntimeAPIProvider apis={apis}><TooltipProvider>
    <RuntimeSyncProvider directory={directory}>
      <main className="min-h-screen bg-background pt-24" data-composer-bound>
        <ProofComposer />
      </main>
      <Toaster />
    </RuntimeSyncProvider>
  </TooltipProvider></RuntimeAPIProvider></ThemeSystemProvider></I18nProvider>;
}
const container = document.getElementById('root');
if (!container) throw new Error('Attachment fixture root missing');
createRoot(container).render(<Fixture />);
