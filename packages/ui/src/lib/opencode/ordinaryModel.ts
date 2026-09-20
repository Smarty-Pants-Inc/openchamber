import { z } from 'zod';
import type { Session } from '@opencode-ai/sdk/v2';

const ordinaryModelSchema = z.object({
  generation: z.string().min(1).nullable(),
  sequence: z.number().int().nonnegative(),
  model: z.object({
    providerID: z.string().min(1),
    modelID: z.string().min(1),
    name: z.string().min(1),
  }).nullable(),
  thinkingLevel: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']).nullable(),
}).refine(value => value.model === null || (value.generation !== null && value.thinkingLevel !== null));

const ordinaryOwnershipSchema = z.object({ nativeRuntime: z.literal('ordinary') });
const ordinarySessionSchema = z.object({ ordinary: ordinaryModelSchema });
export type OrdinaryModelState = z.infer<typeof ordinaryModelSchema>;
const unavailable: OrdinaryModelState = { generation: null, sequence: 0, model: null, thinkingLevel: null };

/** Only session metadata marks native ownership. Catalogs and messages cannot. */
export function readOrdinaryModel(session: Session | undefined): OrdinaryModelState | undefined {
  if (!session) return undefined;
  if (!Object.hasOwn(session, 'ordinary')) return ordinaryOwnershipSchema.safeParse(session).success ? unavailable : undefined;
  const parsed = ordinarySessionSchema.safeParse(session);
  return parsed.success ? parsed.data.ordinary : unavailable;
}

/** A prepared send may not cross a native generation or configuration change. */
export function sameOrdinaryModel(expected: OrdinaryModelState, actual: OrdinaryModelState | undefined): boolean {
  return Boolean(expected.model && actual?.model && expected.generation === actual.generation &&
    expected.model.providerID === actual.model.providerID && expected.model.modelID === actual.model.modelID &&
    expected.thinkingLevel === actual.thinkingLevel);
}

/** Callers gate fetch/event epochs; sequence ordering applies only within one native generation. */
export function mergeOrdinaryModel(current: Session | undefined, incoming: Session): Session {
  if (!current || current.id !== incoming.id || current.directory !== incoming.directory) return incoming;
  const previous = readOrdinaryModel(current);
  const next = readOrdinaryModel(incoming);
  if (!previous) return incoming;
  // Omission is lightweight metadata, but an explicit unavailable value is authoritative.
  if (Object.hasOwn(incoming, 'ordinary') && next &&
    (next.model === null || previous.generation !== next.generation || previous.sequence <= next.sequence)) return incoming;
  const retained = Object.hasOwn(current, 'ordinary') ? { ordinary: previous } : { nativeRuntime: 'ordinary' };
  return { ...incoming, ...retained };
}
