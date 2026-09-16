import type { Session } from '@opencode-ai/sdk/v2';
import { z } from 'zod';

export const nativeCreationHealthSchema = z.object({
  healthy: z.literal(true),
  capabilities: z.object({ ordinaryCreateOnly: z.literal(1).optional() }).optional(),
});
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
type NativeCreationFailureCode = 'target' | 'unsupported' | 'unavailable' | 'unknown' | 'stale' | 'required' | 'model' | 'history' | 'sending';

export class NativeCreationError extends Error {
  constructor(readonly code: NativeCreationFailureCode, cause?: unknown, readonly detail?: string,
    readonly reference?: z.infer<typeof nativeReferenceSchema>) {
    super('Native creation failed', { cause });
  }
}

/** Keep only the backend's safe recovery message, never stringify arbitrary transport errors. */
export function nativeCreationFailure(cause: unknown): NativeCreationError {
  if (cause instanceof NativeCreationError) return cause;
  const parsed = recoveryErrorSchema.safeParse(cause);
  return new NativeCreationError('unknown', cause, parsed.success ? parsed.data.data.message : undefined);
}

export function nativeCreatedSession(session: Session): NativeCreatedSession {
  const parsed = nativeSessionSchema.safeParse(session);
  if (!parsed.success) throw new NativeCreationError('unknown', parsed.error, undefined, nativeReferenceSchema.safeParse(session).data);
  return { ...session, ...parsed.data };
}
