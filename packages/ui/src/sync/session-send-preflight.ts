import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import { z } from "zod"
import { bindRuntimeTransport, type BoundRuntimeTransport } from "@/lib/runtime-fetch"
import { getRuntimeKey, getRuntimeTransportEpoch } from "@/lib/runtime-switch"
const authorizedResponseSchema = z.object({ authorized: z.literal(true) })
const errorResponseSchema = z.object({ error: z.string().min(1) })

export type SessionSendPreflightInput = {
  sessionId: string
  directory?: string | null
  providerID: string
  runtimeKey?: string
}

export type SessionSendAuthority = {
  runtimeKey: string
  client: OpencodeClient
  fetch: BoundRuntimeTransport["fetch"]
}

const runtimeChangedError = (): Error => new Error("Message was not sent because the runtime changed.")
const getBoundSdkBaseUrl = (apiBaseUrl: string): string => new URL(
  apiBaseUrl,
  globalThis.location?.origin ?? "http://openchamber.local",
).toString()

const assertSessionSendRuntime = (
  runtimeKey: string,
  transportEpoch: number,
  expectedRuntimeKey?: string,
): void => {
  if (
    (expectedRuntimeKey && expectedRuntimeKey !== runtimeKey)
    || getRuntimeKey() !== runtimeKey
    || getRuntimeTransportEpoch() !== transportEpoch
  ) {
    throw runtimeChangedError()
  }
}

const authorizeSessionSend = async (
  input: SessionSendPreflightInput,
  request: BoundRuntimeTransport["fetch"],
): Promise<void> => {
  const directory = input.directory?.trim()
  if (!directory) throw Object.assign(new Error("Session directory is required"), { status: 400 })

  const response = await request(
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
  send: (authority: SessionSendAuthority) => Promise<T>,
): Promise<T> {
  const runtimeKey = getRuntimeKey()
  const transportEpoch = getRuntimeTransportEpoch()
  assertSessionSendRuntime(runtimeKey, transportEpoch, input.runtimeKey)
  const transport = bindRuntimeTransport()
  try {
    const client = createOpencodeClient({
      baseUrl: getBoundSdkBaseUrl(transport.apiBaseUrl),
      fetch: transport.fetch,
    })
    await authorizeSessionSend(input, transport.fetch)
    assertSessionSendRuntime(runtimeKey, transportEpoch, input.runtimeKey)
    return await send({ runtimeKey, client, fetch: transport.fetch })
  } finally {
    transport.release()
  }
}
