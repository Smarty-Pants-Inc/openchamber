import { z } from 'zod';
import { isLikelyProviderAuthFailure, PROVIDER_AUTH_FAILURE_MESSAGE } from './providerAuthError';

// Each field falls back on its own: one malformed field must not hide the others' detail.
const optionalString = z.string().optional().catch(undefined);
const assistantErrorSchema = z.object({
  name: optionalString,
  message: optionalString,
  data: z.object({ message: optionalString }).loose().optional().catch(undefined),
}).loose();

/** The notice shown in place of an assistant turn that ended with an error; undefined when there is none. */
export function describeAssistantError(error: unknown): string | undefined {
  const parsed = assistantErrorSchema.safeParse(error);
  if (!parsed.success) return undefined;
  const { name, message, data } = parsed.data;
  const detail = data?.message || message || name;
  if (!detail) return undefined;
  if (name === 'SessionRetry') return `Failed to send a message. Retry attempt info: ${detail}`;
  if (isLikelyProviderAuthFailure(detail)) return PROVIDER_AUTH_FAILURE_MESSAGE;
  // The local settle mark for a turn the client saw end unfinished.
  if (detail.trim().toLowerCase() === 'aborted') return 'The running turn stopped before the next message was sent.';
  // A user's Stop ends the turn on purpose; it is not a send failure.
  if (name === 'MessageAbortedError') return 'Stopped';
  return `Failed to send the message: ${detail}`;
}
