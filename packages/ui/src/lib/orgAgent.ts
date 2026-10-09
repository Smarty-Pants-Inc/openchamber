// smarty-code#1192: the signed-in person's own org agent session, from the gateway's GET /me/org-agent (verified email ->
// the person's one principal -> that principal's org Herdr agent -> its session id, only when the fleet session list
// shows it). The gateway decides; this module only parses its answer.
import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';

const orgAgentSchema = z.object({ sessionId: z.string().min(1), herdrAgent: z.string().min(1), name: z.string().min(1), live: z.boolean() });
export type OrgAgent = z.infer<typeof orgAgentSchema>;
type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/** The person's org agent, or null when they have none (404, or a server without the route). Other failures throw. */
export async function loadOrgAgent(fetcher: Fetcher = runtimeFetch): Promise<OrgAgent | null> {
  // The gateway serves /me/org-agent; OpenChamber's /api prefix maps onto it, as /api/me/smarties does.
  const response = await fetcher('/api/me/org-agent', { credentials: 'include', headers: { accept: 'application/json' } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Org agent read failed (${response.status})`);
  return orgAgentSchema.parse(await response.json());
}
