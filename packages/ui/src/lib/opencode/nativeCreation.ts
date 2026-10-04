import type { Session } from '@opencode-ai/sdk/v2';
import { z } from 'zod';

export const nativeCreationHealthSchema = z.object({
  healthy: z.literal(true),
  capabilities: z.object({ ordinaryCreateOnly: z.literal(1).optional(), ordinaryInteractiveCreate: z.literal(1).optional(),
    sessionVoice: z.literal(1).optional(), sessionVoiceStatus: z.literal(1).optional(), creationClientRequestId: z.literal(1).optional(),
    creationAbandon: z.literal(1).optional(), ordinaryResume: z.literal(1).optional() }).optional(),
});
// Public creation-contract.ts; endpoint and native generations are distinct.
const creationUUID = z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i);
const nativeCreationStateSchema = z.object({
  operationId: creationUUID, directory: z.string().min(1), generation: creationUUID.nullable(),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  phase: z.enum(['awaiting-trust', 'starting', 'denied', 'cancelled', 'expired', 'ready-required', 'ready', 'unavailable']),
  expiresAt: z.number(), native: z.object({ id: creationUUID, generation: creationUUID }).strict().optional(),
  canInitialReady: z.boolean(),
  // The id this browser sent with its create request, echoed so a lost create response can be recovered exactly.
  clientRequestId: creationUUID.optional(),
  // Who stopped an abandoned start (smarty-code#523, #548): the gateway's signed-in person, on a 'cancelled' start only.
  stoppedBy: z.object({ issuer: z.string().min(1).max(256), subject: z.string().min(1).max(256), name: z.string().min(1).max(256) })
    .strict().optional(),
  // An expired start: what it was waiting for, as the gateway recorded it (smarty-code#751), in plain words.
  waitingFor: z.string().min(1).max(200).optional(),
}).strict();
export const nativeCreationResponseSchema = z.object({ nativeCreation: nativeCreationStateSchema }).strict();
export const nativeCreationListSchema = z.object({ nativeCreations: z.array(nativeCreationStateSchema) }).strict();
export type NativeCreationState = z.infer<typeof nativeCreationStateSchema>;
export type NativeCreationReply = { generation: string; revision: number } & (
  | { action: 'trust' | 'deny' | 'cancel'; native?: never }
  | { action: 'ready'; native: { id: string; generation: string } }
);
export type NativeCreationResult = NativeCreatedSession | z.infer<typeof nativeCreationResponseSchema>;
/** GET /api/session/:id/voice: availability, a plain reason and an optional hint to retry a temporary negative. */
export const sessionVoiceSchema = z.union([
  z.object({ available: z.literal(true) }).strict(),
  z.object({ available: z.literal(false), reason: z.string().min(1).max(300), retry: z.boolean().optional() }).strict(),
]);
export const NATIVE_CREATION_INVALIDATED = 'openchamber:native-creation-invalidated';

const nativeReferenceSchema = z.object({ id: z.uuid(), directory: z.string().min(1) });
const nativeSessionSchema = nativeReferenceSchema.extend({
  nativeCreation: z.object({
    model: z.object({ providerID: z.string().min(1), modelID: z.string().min(1) }),
    inputReady: z.boolean(),
  }),
});
const recoveryErrorSchema = z.object({
  name: z.literal('APIError'),
  data: z.object({ message: z.string().min(1), isRetryable: z.literal(false) }),
});

export type NativeCreatedSession = Session & z.infer<typeof nativeSessionSchema>;
type NativeCreationFailureCode = 'target' | 'unsupported' | 'unavailable' | 'unknown' | 'stale' | 'required' | 'model' | 'history' | 'sending' | 'stopped' | 'notReady' | 'elsewhere' | 'storage';

export class NativeCreationError extends Error {
  /** `status` is the HTTP status of a definite refusal: the server answered and did not act on the request. */
  constructor(readonly code: NativeCreationFailureCode, cause?: unknown, readonly detail?: string,
    readonly reference?: z.infer<typeof nativeReferenceSchema>, readonly status?: number) {
    super('Native creation failed', { cause });
  }
}

/** Keep only the backend's safe recovery message, never stringify arbitrary transport errors. */
export function nativeCreationFailure(cause: unknown, status?: number): NativeCreationError {
  if (cause instanceof NativeCreationError) return cause;
  const parsed = recoveryErrorSchema.safeParse(cause);
  return new NativeCreationError('unknown', cause, parsed.success ? parsed.data.data.message : undefined, undefined, status);
}

export function nativeCreatedSession(session: Session): NativeCreatedSession {
  const parsed = nativeSessionSchema.safeParse(session);
  if (!parsed.success) throw new NativeCreationError('unknown', parsed.error, undefined, nativeReferenceSchema.safeParse(session).data);
  return { ...session, ...parsed.data };
}
