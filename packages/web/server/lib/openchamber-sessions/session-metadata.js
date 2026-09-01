import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

const mutationLocks = new Map();

const recordSchema = z.record(z.string(), z.unknown());
const sessionSchema = z.object({ id: z.string().min(1) }).passthrough();
const metadataKeySchema = z.string().regex(/^[A-Za-z0-9_]+$/);
const operationSchema = z.object({
  type: z.enum(['set', 'delete']),
  path: z.tuple([z.literal('openchamber'), metadataKeySchema]),
  expected: z.discriminatedUnion('exists', [
    z.object({ exists: z.literal(true), value: z.unknown() }),
    z.object({ exists: z.literal(false) }),
  ]),
}).passthrough();

const isRecord = (value) => recordSchema.safeParse(value).success;

const metadataRecord = (value) => (isRecord(value) ? value : {});

const openChamberRecord = (metadata) => {
  const namespace = metadataRecord(metadata).openchamber;
  return isRecord(namespace) ? namespace : {};
};

const mutationKey = (sessionID, directory) => `${directory || ''}\u0000${sessionID}`;

const withMutationLock = async (key, operation) => {
  const previous = mutationLocks.get(key) || Promise.resolve();
  let release;
  const next = new Promise((resolve) => {
    release = resolve;
  });
  mutationLocks.set(key, next);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (mutationLocks.get(key) === next) mutationLocks.delete(key);
  }
};

const changedOpenChamberKeys = (before, after) => {
  const previous = openChamberRecord(before);
  const next = openChamberRecord(after);
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  return [...keys].filter((key) => !isDeepStrictEqual(previous[key], next[key]));
};

const hasAppliedKeys = (session, metadata, keys) => {
  const current = openChamberRecord(session?.metadata);
  const expected = openChamberRecord(metadata);
  return keys.every((key) => isDeepStrictEqual(current[key], expected[key]));
};

const sessionFromResult = (value, operation) => {
  const parsed = sessionSchema.safeParse(value?.data ?? value);
  if (!parsed.success) throw new Error(`failed to ${operation}`);
  return parsed.data;
};

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

const validKey = (value) => metadataKeySchema.safeParse(value).success;

const asOperation = (value) => {
  const parsed = operationSchema.safeParse(value);
  if (!parsed.success || !validKey(parsed.data.path[1])) {
    throw new SessionMetadataConflictError('Invalid session metadata operation', 400);
  }
  if (parsed.data.type === 'set' && !hasOwn(parsed.data, 'value')) {
    throw new SessionMetadataConflictError('Invalid session metadata operation', 400);
  }
  const operation = {
    type: parsed.data.type,
    key: parsed.data.path[1],
    expected: parsed.data.expected.exists
      ? { exists: true, value: parsed.data.expected.value }
      : { exists: false },
  };
  if (parsed.data.type === 'set') operation.value = parsed.data.value;
  return operation;
};

export class SessionMetadataConflictError extends Error {
  constructor(message = 'Session metadata changed before the update could be applied', statusCode = 409) {
    super(message);
    this.name = 'SessionMetadataConflictError';
    this.statusCode = statusCode;
  }
}

/**
 * Serializes metadata read/modify/write operations for one server-owned
 * session. Writers provide their own transport adapters, so the same lock and
 * outcome recovery covers SDK and fetch-backed server runtimes.
 */
export const createSessionMetadataMutationRuntime = () => {
  const mutate = async ({
    sessionID,
    directory,
    readSession,
    writeMetadata,
    mutateMetadata,
    signal,
    assertCurrent,
  }) => {
    const parsedSessionID = z.string().min(1).safeParse(sessionID);
    if (!parsedSessionID.success) throw new Error('session id is required');
    if (!readSession || !writeMetadata || !mutateMetadata) {
      throw new Error('session metadata mutation requires read, write, and mutation functions');
    }
    sessionID = parsedSessionID.data;

    return withMutationLock(mutationKey(sessionID, directory), async () => {
      assertCurrent?.();
      const current = sessionFromResult(await readSession(signal), 'read session metadata');
      assertCurrent?.();
      const currentMetadata = metadataRecord(current.metadata);
      const mutation = mutateMetadata(currentMetadata, current);
      const nextMetadata = metadataRecord(mutation?.metadata);
      const changedKeys = changedOpenChamberKeys(currentMetadata, nextMetadata);
      if (changedKeys.length === 0) {
        return { session: current, changed: false, result: mutation?.result };
      }

      try {
        const written = sessionFromResult(await writeMetadata(nextMetadata), 'update session metadata');
        return { session: written, changed: true, result: mutation?.result };
      } catch (error) {
        // A transport failure after an update request can be ambiguous. Read the
        // same session again while holding the lock and accept the result only
        // when every field this mutation owned reached its requested value.
        try {
          const recovered = sessionFromResult(await readSession(), 'recover session metadata update');
          if (hasAppliedKeys(recovered, nextMetadata, changedKeys)) {
            return { session: recovered, changed: true, recovered: true, result: mutation?.result };
          }
        } catch {
          // Preserve the original update error when recovery cannot establish an outcome.
        }
        throw error;
      }
    });
  };

  const mutateOperations = async ({ operations, ...input }) => {
    if (!Array.isArray(operations) || operations.length === 0) {
      throw new SessionMetadataConflictError('At least one session metadata operation is required', 400);
    }
    const parsedOperations = operations.map(asOperation);
    return mutate({
      ...input,
      mutateMetadata: (metadata) => {
        const currentNamespace = openChamberRecord(metadata);
        for (const operation of parsedOperations) {
          const exists = hasOwn(currentNamespace, operation.key);
          if (exists !== operation.expected.exists
            || (exists && !isDeepStrictEqual(currentNamespace[operation.key], operation.expected.value))) {
            throw new SessionMetadataConflictError();
          }
        }

        const nextNamespace = { ...currentNamespace };
        for (const operation of parsedOperations) {
          if (operation.type === 'delete') delete nextNamespace[operation.key];
          else nextNamespace[operation.key] = operation.value;
        }
        return {
          metadata: { ...metadata, openchamber: nextNamespace },
          result: { operations: parsedOperations.length },
        };
      },
    });
  };

  return { mutate, mutateOperations };
};

export const sessionMetadataMutationRuntime = createSessionMetadataMutationRuntime();
