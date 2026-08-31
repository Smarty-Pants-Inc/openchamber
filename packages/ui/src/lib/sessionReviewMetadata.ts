import type { Session } from '@opencode-ai/sdk/v2';

export type SessionMetadataRecord = Record<string, unknown>;

export type AgentBackendProviderID = 'omp' | 'pi' | 'codex';
export type RequestedAgentBackend = 'native' | AgentBackendProviderID;
export type PersistedAgentBackend = RequestedAgentBackend | 'unknown';

const isAgentBackendProviderID = (value: unknown): value is AgentBackendProviderID =>
  value === 'omp' || value === 'pi' || value === 'codex';

type OpenChamberMetadata = {
  kind?: 'review';
  originalSessionID?: string;
  reviewSessionID?: string;
  agent_backend?: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

export const getSessionMetadata = (session: Session | null | undefined): SessionMetadataRecord => {
  const metadata = (session as (Session & { metadata?: unknown }) | null | undefined)?.metadata;
  return isRecord(metadata) ? metadata : {};
};

const getOpenChamberMetadata = (metadata: SessionMetadataRecord): OpenChamberMetadata => {
  const value = metadata.openchamber;
  return isRecord(value) ? value as OpenChamberMetadata : {};
};

type SessionMessageProviderRecord = {
  info?: {
    providerID?: string;
    model?: { providerID?: string };
  };
};

/** Returns a managed provider found in authoritative session history. */
export const getAgentBackendProviderIDFromMessageRecords = (
  records: readonly SessionMessageProviderRecord[],
): AgentBackendProviderID | null => {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const info = records[index]?.info;
    const providerID = info?.model?.providerID ?? info?.providerID;
    if (isAgentBackendProviderID(providerID)) return providerID;
  }
  return null;
};

export const getAgentBackendProviderID = (session: Session | null | undefined): AgentBackendProviderID | null => {
  const value = getOpenChamberMetadata(getSessionMetadata(session)).agent_backend;
  return isAgentBackendProviderID(value) ? value : null;
};
export const classifyRequestedAgentBackend = (providerID: string): RequestedAgentBackend =>
  isAgentBackendProviderID(providerID) ? providerID : 'native';

export const classifyPersistedAgentBackend = (
  session: Session | null | undefined,
): PersistedAgentBackend => {
  const openchamber = getOpenChamberMetadata(getSessionMetadata(session));
  if (!Object.prototype.hasOwnProperty.call(openchamber, 'agent_backend')) return 'native';
  const backend = openchamber.agent_backend;
  return isAgentBackendProviderID(backend) ? backend : 'unknown';
};


export const isSessionForkSupported = (session: Session | null | undefined): boolean =>
  Boolean(session) && getAgentBackendProviderID(session) === null && !isReviewSession(session);

export const withAgentBackendMetadata = (
  metadata: SessionMetadataRecord | undefined,
  providerID: string,
): SessionMetadataRecord | undefined => {
  const requestedBackend = classifyRequestedAgentBackend(providerID);
  if (isAgentBackendProviderID(requestedBackend)) {
    const source = metadata ?? {};
    return {
      ...source,
      openchamber: {
        ...getOpenChamberMetadata(source),
        agent_backend: requestedBackend,
      },
    };
  }

  if (!metadata || !isRecord(metadata.openchamber)) return metadata;
  if (!Object.prototype.hasOwnProperty.call(metadata.openchamber, 'agent_backend')) return metadata;

  const openchamber = { ...metadata.openchamber };
  delete openchamber.agent_backend;
  const next = { ...metadata };
  if (Object.keys(openchamber).length > 0) {
    next.openchamber = openchamber;
  } else {
    delete next.openchamber;
  }
  return Object.keys(next).length > 0 ? next : undefined;
};

export const getReviewSessionID = (session: Session | null | undefined): string | null => {
  const value = getOpenChamberMetadata(getSessionMetadata(session)).reviewSessionID;
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
};

export const getOriginalSessionID = (session: Session | null | undefined): string | null => {
  const value = getOpenChamberMetadata(getSessionMetadata(session)).originalSessionID;
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
};

export const isReviewSession = (session: Session | null | undefined): boolean =>
  getOpenChamberMetadata(getSessionMetadata(session)).kind === 'review' && Boolean(getOriginalSessionID(session));

export const withReviewSessionLink = (
  metadata: SessionMetadataRecord,
  reviewSessionID: string,
): SessionMetadataRecord => {
  const current = getOpenChamberMetadata(metadata);
  return {
    ...metadata,
    openchamber: {
      ...current,
      reviewSessionID,
    },
  };
};

export const withReviewSessionMarker = (
  metadata: SessionMetadataRecord,
  originalSessionID: string,
): SessionMetadataRecord => {
  const current = getOpenChamberMetadata(metadata);
  return {
    ...metadata,
    openchamber: {
      ...current,
      kind: 'review' as const,
      originalSessionID,
    },
  };
};

export const withoutReviewSessionLink = (
  metadata: SessionMetadataRecord,
  reviewSessionID: string,
): SessionMetadataRecord => {
  const current = getOpenChamberMetadata(metadata);
  if (current.reviewSessionID !== reviewSessionID) return metadata;

  const restOpenChamber = { ...current };
  delete restOpenChamber.reviewSessionID;
  const next: SessionMetadataRecord = { ...metadata };
  if (Object.keys(restOpenChamber).length > 0) {
    next.openchamber = restOpenChamber;
  } else {
    delete next.openchamber;
  }
  return next;
};
