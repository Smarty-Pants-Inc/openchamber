import { z } from "zod"
import { runtimeFetch } from "@/lib/runtime-fetch"

const authorizedResponseSchema = z.object({ authorized: z.literal(true) })
const errorResponseSchema = z.object({ error: z.string().min(1) })

export type SessionSendPreflightInput = {
  sessionId: string
  directory?: string | null
  providerID: string
}

export async function preflightSessionSend(input: SessionSendPreflightInput): Promise<void> {
  const directory = input.directory?.trim()
  if (!directory) throw Object.assign(new Error("Session directory is required"), { status: 400 })

  const response = await runtimeFetch(
    `/api/openchamber/sessions/${encodeURIComponent(input.sessionId)}/send-preflight`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ directory, providerID: input.providerID }),
    },
  )
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    const error = errorResponseSchema.safeParse(payload)
    throw Object.assign(
      new Error(error.success ? error.data.error : `Session send authorization failed (${response.status})`),
      { status: response.status },
    )
  }
  if (!authorizedResponseSchema.safeParse(payload).success) {
    throw Object.assign(new Error("Invalid session send authorization response"), { status: 502 })
  }
}

export async function withSessionSendPreflight<T>(
  input: SessionSendPreflightInput,
  send: () => Promise<T>,
): Promise<T> {
  await preflightSessionSend(input)
  return send()
}
