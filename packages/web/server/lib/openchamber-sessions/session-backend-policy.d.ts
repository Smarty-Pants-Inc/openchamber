export type ManagedSessionBackend = 'pi' | 'omp';
export type SessionBackendClass = 'native' | ManagedSessionBackend;

export type SessionBackendPolicySession = {
  metadata?: object | null;
};

export type SessionBackendPolicyMessage = {
  info?: {
    providerID?: string;
    model?: { providerID?: string };
  };
};

export type SessionBackendHistoryPage = {
  records?: readonly SessionBackendPolicyMessage[] | null;
  nextCursor?: string | null;
};

export type SessionBackendDecision = {
  backend: ManagedSessionBackend | null;
  backfillBackend: ManagedSessionBackend | null;
};

export class SessionBackendPolicyError extends Error {
  constructor(code: string, message: string, category?: 'conflict' | 'incomplete-history');
  readonly code: string;
  readonly category: 'conflict' | 'incomplete-history';
}

export function isManagedBackendProviderID(
  providerID?: string | null,
): providerID is ManagedSessionBackend;
export function withAgentBackendMetadata<T extends object>(
  metadata: T,
  providerID: ManagedSessionBackend,
): T & { openchamber: object & { agent_backend: ManagedSessionBackend } };

export function foldSessionBackendHistory(
  readPage: (before?: string) => Promise<SessionBackendHistoryPage>,
): Promise<SessionBackendClass>;

export function resolveSessionSend(input: {
  session: SessionBackendPolicySession;
  historyBackendClass: SessionBackendClass;
}): SessionBackendDecision;
export function assertSessionSendBackend(input: {
  backend: ManagedSessionBackend | null;
  providerID: string;
}): void;
export function assertForkSourceSession(session: SessionBackendPolicySession): void;
export function resolveSessionForkSource(input: {
  session: SessionBackendPolicySession;
  historyBackendClass: SessionBackendClass;
}): SessionBackendDecision;
export function assertSessionForkSourceBackend(backend: ManagedSessionBackend | null): void;
export function authorizeSessionForkTarget(input: {
  sourceBackend: ManagedSessionBackend | null;
  targetProviderID?: string | null;
}): void;
export function authorizeManagedBackendStamp(input: {
  session: SessionBackendPolicySession;
  providerID: ManagedSessionBackend;
}): SessionBackendDecision;
