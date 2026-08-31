import { describe, expect, it } from 'vitest';

import { createSessionMetadataMutationRuntime } from './session-metadata.js';

const session = (metadata) => ({ id: 'ses_metadata', metadata });

const mutationInput = (state, mutateMetadata) => ({
  sessionID: 'ses_metadata',
  directory: '/repo/app',
  readSession: async () => session(state.value.metadata),
  writeMetadata: async (metadata) => {
    state.value = session(metadata);
    return state.value;
  },
  mutateMetadata,
});

describe('session metadata mutation runtime', () => {
  it('serializes fresh metadata mutations so sibling leaves both survive', async () => {
    const runtime = createSessionMetadataMutationRuntime();
    const state = { value: session({ openchamber: {} }) };

    await Promise.all([
      runtime.mutate(mutationInput(state, (metadata) => ({
        metadata: { ...metadata, openchamber: { ...metadata.openchamber, goal: { id: 'goal-a' } } },
      }))),
      runtime.mutate(mutationInput(state, (metadata) => ({
        metadata: { ...metadata, openchamber: { ...metadata.openchamber, assist: { suggestion: 'Continue' } } },
      }))),
    ]);

    expect(state.value.metadata).toEqual({
      openchamber: {
        goal: { id: 'goal-a' },
        assist: { suggestion: 'Continue' },
      },
    });
  });

  it('recovers an update whose transport fails after OpenCode applied it', async () => {
    const runtime = createSessionMetadataMutationRuntime();
    const state = { value: session({ openchamber: {} }) };

    const result = await runtime.mutate({
      ...mutationInput(state, (metadata) => ({
        metadata: { ...metadata, openchamber: { ...metadata.openchamber, goal: { id: 'goal-a' } } },
      })),
      writeMetadata: async (metadata) => {
        state.value = session(metadata);
        throw new Error('connection closed after write');
      },
    });

    expect(result).toMatchObject({ recovered: true, changed: true });
    expect(result.session.metadata.openchamber.goal).toEqual({ id: 'goal-a' });
  });

  it('rejects stale metadata operations without writing', async () => {
    const runtime = createSessionMetadataMutationRuntime();
    const state = { value: session({ openchamber: { goal: { id: 'goal-a' } } }) };
    let writes = 0;

    await expect(runtime.mutateOperations({
      sessionID: 'ses_metadata',
      directory: '/repo/app',
      operations: [{
        type: 'set',
        path: ['openchamber', 'goal'],
        expected: { exists: false },
        value: { id: 'goal-b' },
      }],
      readSession: async () => state.value,
      writeMetadata: async (metadata) => {
        writes += 1;
        state.value = session(metadata);
        return state.value;
      },
    })).rejects.toMatchObject({ statusCode: 409 });

    expect(writes).toBe(0);
  });
});
