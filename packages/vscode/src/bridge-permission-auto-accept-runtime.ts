import type { commands } from 'vscode';
import type { BridgeRequest } from './bridge';

type PolicyContext = {
  globalState: {
    get: (key: string) => PermissionAutoAcceptSnapshot | undefined;
    update: (key: string, value: PermissionAutoAcceptSnapshot) => PromiseLike<void>;
  };
};

export type PermissionAutoAcceptSnapshot = {
  sessions: Record<string, boolean>;
  revision: number;
};

export async function handlePermissionAutoAcceptBridgeMessage(
  message: BridgeRequest,
  _context?: PolicyContext,
  _dependencies?: { broadcast: (snapshot: PermissionAutoAcceptSnapshot) => ReturnType<typeof commands.executeCommand> },
) {
  void _context; void _dependencies;
  if (message.type !== 'api:permission-auto-accept:get' && message.type !== 'api:permission-auto-accept:set') {
    return null;
  }
  // Refuse before reading, writing or broadcasting persisted policy. There is
  // no extension setting or foreground fallback that can enable this feature.
  return {
    id: message.id,
    type: message.type,
    success: false,
    error: 'Permission auto-accept is unsupported in this fork',
    data: { supported: false, status: 501 },
  };
}
