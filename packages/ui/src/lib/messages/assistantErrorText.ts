import { z } from 'zod';
import { isLikelyProviderAuthFailure, PROVIDER_AUTH_FAILURE_MESSAGE } from './providerAuthError';

// Each field falls back on its own: one malformed field must not hide the others' detail.
const optionalString = z.string().optional().catch(undefined);
const assistantErrorSchema = z.object({
  name: optionalString,
  message: optionalString,
  data: z.object({ message: optionalString, resetsAt: optionalString }).loose().optional().catch(undefined),
}).loose();

/** A reset time as the person's own local clock time ("6:30 AM"), with the date when it is not within the next day
 * ("Oct 28, 9:37 AM"), as the gateway words it (a date only beyond 20 hours). */
const localTime = (iso: string) => (Math.abs(Date.parse(iso) - Date.now()) < 20 * 3600_000
  ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  : new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }));

/**
 * The org's usage limit (smarty-net#136 L3; the gateway's SmartyLimitError): its own plain message, with a UTC time in it
 * ("… at 10:30Z", or "… at 2026-10-28 13:37Z") shown as the person's local time. No status, no JSON, no "Failed to send".
 */
export function describeUsageLimit(message: string, resetsAt: string | undefined, format = localTime): string {
  const reset = resetsAt && !Number.isNaN(Date.parse(resetsAt)) ? format(resetsAt) : undefined;
  if (!reset) return message;
  const local = message.replace(/\b(?:\d{4}-\d{2}-\d{2} )?\d{1,2}:\d{2}\s?(?:Z|UTC)\b/g, reset);
  return local === message ? `${message} It resets at ${reset}.` : local;
}

/** The notice shown in place of an assistant turn that ended with an error; undefined when there is none. */
export function describeAssistantError(error: unknown, format = localTime): string | undefined {
  const parsed = assistantErrorSchema.safeParse(error);
  if (!parsed.success) return undefined;
  const { name, message, data } = parsed.data;
  const detail = data?.message || message || name;
  if (!detail) return undefined;
  if (name === 'SmartyLimitError') return describeUsageLimit(detail, data?.resetsAt, format);
  if (name === 'SessionRetry') return `Failed to send a message. Retry attempt info: ${detail}`;
  if (isLikelyProviderAuthFailure(detail)) return PROVIDER_AUTH_FAILURE_MESSAGE;
  // The local settle mark for a turn the client saw end unfinished.
  if (detail.trim().toLowerCase() === 'aborted') return 'The running turn stopped before the next message was sent.';
  // A user's Stop ends the turn on purpose; it is not a send failure.
  if (name === 'MessageAbortedError') return 'Stopped';
  return `Failed to send the message: ${detail}`;
}
