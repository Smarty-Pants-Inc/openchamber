import { z } from 'zod'
import type { SessionStatus as SDKSessionStatus } from '@opencode-ai/sdk/v2/client'

const ordinaryFields = {
  ordinary: z.boolean().optional(),
  ordinaryTarget: z.object({
    generation: z.string().min(1),
    presentationId: z.string().min(1),
  }).nullable().optional(),
  // An extension dialog is open in Pi's terminal (slice 1 L4). Pi has no handle a browser answer could settle, so the
  // page only says where to answer it; it never answers or acknowledges it.
  ordinaryDialog: z.object({
    kind: z.enum(['select', 'confirm', 'input', 'editor', 'custom']),
    title: z.string().max(200).optional(),
  }).nullable().optional().catch(null),
}
const statusSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('idle'), ...ordinaryFields }),
  z.object({ type: z.literal('busy'), ...ordinaryFields }),
  z.object({ type: z.literal('retry'), attempt: z.number(), message: z.string(), next: z.number(), ...ordinaryFields }),
])

export type SessionStatus = z.infer<typeof statusSchema>

// SDK declarations describe stock OpenCode, but the gateway adds Stop authority.
// Parse it once at status ingress; never derive a target from message history.
export const parseSessionStatus = (status: SDKSessionStatus): SessionStatus => statusSchema.parse(status)
export const parseSessionStatusMap = (statuses: Record<string, SDKSessionStatus>): Record<string, SessionStatus> =>
  Object.fromEntries(Object.entries(statuses).map(([id, status]) => [id, parseSessionStatus(status)]))

export const ordinaryAbortOptions = (status: SessionStatus | undefined) => {
  if (!status?.ordinary) return undefined
  const target = status.type === 'busy' ? status.ordinaryTarget : null
  if (!target) throw new Error('Ordinary Stop target is unavailable')
  return {
    headers: {
      'x-smarty-ordinary-generation': target.generation,
      'x-smarty-ordinary-presentation-id': target.presentationId,
    },
    throwOnError: true as const,
  }
}
