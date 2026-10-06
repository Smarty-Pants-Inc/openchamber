import http from 'node:http';
import { describe, expect, it, vi } from 'vitest';

import { createStartupPipelineRuntime } from './startup-pipeline-runtime.js';

describe('startup pipeline runtime', () => {
  it('publishes the listening port before bootstrapping managed OpenCode', async () => {
    const order = [];
    const runtime = createStartupPipelineRuntime({

      createDictationRuntime: () => ({}),
      createMessageStreamWsRuntime: () => ({}),
      createServerStartupRuntime: () => ({
        resolveBindHost: () => '127.0.0.1',
        startListeningAndMaybeTunnel: async () => {
          order.push('listen');
          return { activePort: 3901 };
        },
        attachProcessHandlers: vi.fn(),
      }),
    });

    const server = http.createServer();
    server.on('upgrade', () => {});
    await runtime.run({
      app: { get: vi.fn(), use: () => order.push('retired-route-refusal') },
      setupProxy: () => order.push('proxy'),
      staticRoutesRuntime: { registerStaticRoutes: vi.fn() },
      apiOnly: false,
      tunnelRuntimeContext: {
        setActivePort: (port) => order.push(`port:${port}`),
      },
      scheduleOpenCodeApiDetection: () => order.push('detect'),
      bootstrapOpenCodeAtStartup: () => order.push('bootstrap'),
      process: {},
      crypto: {},
      server,
      attachSignals: false,
    });

    expect(order).toEqual(['retired-route-refusal', 'proxy', 'listen', 'port:3901', 'detect', 'bootstrap']);
    expect(server.listeners('upgrade')[0].name).toBe('refuseRetiredRouteUpgrade');
  });
});
