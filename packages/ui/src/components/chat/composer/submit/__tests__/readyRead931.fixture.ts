import { z } from 'zod';
import type { NativeCreationState } from '@/lib/opencode/nativeCreation';
import { session, directory } from '@/sync/native-draft-fixture';
import { mountedNativeComposer } from './nativeComposer.fixture';

const operationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const endpoint = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const generation = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
export const readyDetail931 = { ...session, nativeCreation: undefined, ordinary: { generation, sequence: 1,
  model: { providerID: 'cliproxyapi', modelID: 'gpt-6-astra', name: 'GPT-6 Astra' }, thinkingLevel: 'medium' } };
const requestBody = z.object({ clientRequestId: z.string() });
const replyBody = z.object({ action: z.enum(['trust', 'ready']) });

type Fixture = Parameters<NonNullable<Parameters<typeof mountedNativeComposer>[4]>>[0];
type ReadyServer931 = { operation?: NativeCreationState; actions: string[]; detailReads: Request[]; operationReads: Request[];
  detail: (request: Request) => Promise<Response>; readOperation: (request: Request) => Promise<Response>;
  replyResponse: (operation: NativeCreationState) => Promise<Response>; restore: () => void };
/** Synthetic HTTP only. Composer, creation control, SDK, stores and accepted-history loader stay real. */
export function readyServer931(fixture: Fixture) {
  const server: ReadyServer931 = {
    actions: [], detailReads: [], operationReads: [], detail: async () => Response.json(readyDetail931),
    readOperation: async () => Response.json({ nativeCreation: server.operation }),
    replyResponse: async operation => Response.json({ nativeCreation: operation }), restore: () => {},
  };
  fixture.handlers.health = async () => Response.json({ healthy: true,
    capabilities: { ordinaryInteractiveCreate: 1, creationClientRequestId: 1 } });
  fixture.handlers.create = async request => {
    const body = requestBody.parse(await request.json());
    server.operation = { operationId, directory, generation: endpoint, revision: 1, phase: 'awaiting-trust',
      expiresAt: Date.now() + 60_000, canInitialReady: false, clientRequestId: body.clientRequestId };
    return Response.json({ nativeCreation: server.operation }, { status: 202 });
  };
  const inner = globalThis.fetch;
  server.restore = () => { globalThis.fetch = inner; };
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init), path = new URL(request.url).pathname;
    if (!path.includes('/session/creation') && !path.endsWith(`/session/${session.id}`)) return inner(input, init);
    fixture.requests.push(request.clone());
    if (path.endsWith('/creation')) return Response.json({ nativeCreations: server.operation ? [server.operation] : [] });
    if (path.endsWith('/reply')) {
      const { action } = replyBody.parse(await request.json());
      const previous = server.operation;
      if (!previous) throw new Error('Reply before create');
      server.actions.push(action);
      server.operation = action === 'trust'
        ? { ...previous, revision: previous.revision + 1, phase: 'ready-required',
          native: { id: session.id, generation }, canInitialReady: true }
        : { ...previous, revision: previous.revision + 1, phase: 'ready' };
      return server.replyResponse(server.operation);
    }
    if (path.endsWith(`/creation/${operationId}`)) {
      server.operationReads.push(request);
      return server.readOperation(request);
    }
    server.detailReads.push(request);
    return server.detail(request);
  }, inner);
  return server;
}
