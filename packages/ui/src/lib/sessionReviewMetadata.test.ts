import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import {
  classifyPersistedAgentBackend,
  classifyRequestedAgentBackend,
  getAgentBackendProviderID,
  getAgentBackendProviderIDFromMessageRecords,
  isSessionForkSupported,
  withAgentBackendMetadata,
} from './sessionReviewMetadata';
import type { SessionMetadataRecord } from './sessionReviewMetadata';

const sessionWith = (metadata: SessionMetadataRecord): Session => ({
  id: 'session',
  slug: 'session',
  projectID: 'project',
  directory: '/project',
  title: 'Session',
  version: '1',
  time: { created: 1, updated: 1 },
  metadata,
});

describe('managed backend classification', () => {
  test('recognizes Codex in requests, persisted metadata, and authoritative history', () => {
    const session = sessionWith({ openchamber: { agent_backend: 'codex' } });

    expect(classifyRequestedAgentBackend('codex')).toBe('codex');
    expect(getAgentBackendProviderID(session)).toBe('codex');
    expect(classifyPersistedAgentBackend(session)).toBe('codex');
    expect(getAgentBackendProviderIDFromMessageRecords([
      { info: { model: { providerID: 'anthropic' } } },
      { info: { model: { providerID: 'codex' } } },
    ])).toBe('codex');
    expect(getAgentBackendProviderIDFromMessageRecords([
      { info: { providerID: 'codex' } },
    ])).toBe('codex');
    expect(isSessionForkSupported(session)).toBe(false);
    expect(classifyRequestedAgentBackend('anthropic')).toBe('native');
    expect(classifyPersistedAgentBackend(sessionWith({ openchamber: {} }))).toBe('native');
    expect(classifyPersistedAgentBackend(sessionWith({
      openchamber: { agent_backend: 'anthropic' },
    }))).toBe('unknown');
  });

  test('stamps Codex while preserving review and BTW inheritance metadata', () => {
    expect(withAgentBackendMetadata({
      keep: true,
      openchamber: { kind: 'review', originalSessionID: 'original' },
    }, 'codex')).toEqual({
      keep: true,
      openchamber: { kind: 'review', originalSessionID: 'original', agent_backend: 'codex' },
    });
    expect(withAgentBackendMetadata({
      openchamber: { kind: 'btw', originalSessionID: 'parent', btwBoundaryMessageID: 'message' },
    }, 'codex')).toEqual({
      openchamber: {
        kind: 'btw',
        originalSessionID: 'parent',
        btwBoundaryMessageID: 'message',
        agent_backend: 'codex',
      },
    });
  });
});
