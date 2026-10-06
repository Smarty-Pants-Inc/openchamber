// smarty-code#1407: which session is the person's own Smarty (their org agent), through the gateway's
// GET /api/me/org-agent. The gateway decides whose agent it is (the signed-in person).
import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';

const orgAgentSchema = z.object({ sessionId: z.string().min(1), herdrAgent: z.string(), name: z.string().min(1), live: z.boolean() });
export type OrgAgent = z.infer<typeof orgAgentSchema>;
/** `none` is only the gateway's own answer (404 no_org_agent); every other failure throws, so it never reads as none. */
export type OrgAgentResult = { state: 'ready'; agent: OrgAgent } | { state: 'none' };
type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

class OrgAgentRequestError extends Error {
  constructor(readonly status: number) { super(`Org agent request failed (${status})`); }
}

export async function loadOrgAgent(fetcher: Fetcher = runtimeFetch): Promise<OrgAgentResult> {
  const response = await fetcher('/api/me/org-agent', { credentials: 'include', headers: { accept: 'application/json' } });
  if (response.status === 404) {
    const body = z.object({ error: z.literal('no_org_agent') }).safeParse(await response.json().catch(() => null));
    if (body.success) return { state: 'none' };
    throw new OrgAgentRequestError(response.status);
  }
  if (!response.ok) throw new OrgAgentRequestError(response.status);
  return { state: 'ready', agent: orgAgentSchema.parse(await response.json()) };
}
