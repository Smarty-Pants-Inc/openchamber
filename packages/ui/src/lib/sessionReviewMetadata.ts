import type { Session } from '@opencode-ai/sdk/v2';

export type SessionMetadataRecord = Record<string, unknown>;

type AgentBackendProviderID = 'omp' | 'pi';

type OpenChamberMetadata = {
  kind?: 'review';
  originalSessionID?: string;
  reviewSessionID?: string;
  agent_backend?: AgentBackendProviderID;
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

export const getAgentBackendProviderID = (session: Session | null | undefined): AgentBackendProviderID | null => {
  const value = getOpenChamberMetadata(getSessionMetadata(session)).agent_backend;
  return value === 'omp' || value === 'pi' ? value : null;
};

export const withAgentBackendMetadata = (
  metadata: SessionMetadataRecord | undefined,
  providerID: string,
): SessionMetadataRecord | undefined => {
  if (providerID !== 'omp' && providerID !== 'pi') return metadata;
  const source = metadata ?? {};
  return {
    ...source,
    openchamber: {
      ...getOpenChamberMetadata(source),
      agent_backend: providerID,
    },
  };
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
