import assert from 'node:assert/strict';
import { test } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import request from 'supertest';
import { createBasePathMiddleware } from '../base-path.js';
import { createHumanAuth } from './human-auth.js';
import { createUiAuth } from './ui-auth.js';
import { createBootstrapRuntime } from '../opencode/bootstrap-runtime.js';
import { registerAuthAndAccessRoutes, registerCommonRequestMiddleware, registerServerStatusRoutes } from '../opencode/core-routes.js';

test('HTTP auth routes preserve the prefix and generate prefixed OAuth callbacks', async () => {
  const database = new DatabaseSync(':memory:');
  const origin = 'http://localhost:43210';
  const publicBase = origin + '/code';
  const humanAuth = await createHumanAuth({ database, baseURL: publicBase,
    secret: 'fixture-only-secret-thirty-two-characters', googleClientId: 'fixture-client',
    googleClientSecret: 'fixture-secret', allowedDomains: ['example.test'] });
  const app = express();
  const tunnelAuthController = { classifyRequestScope: () => 'local', requireTunnelSession: (_req, res) => res.status(403).end() };
  try {
    app.use(createBasePathMiddleware('/code', ['/api/auth']));
    const bootstrap = createBootstrapRuntime({ express, createUiAuth,
      registerServerStatusRoutes, registerCommonRequestMiddleware, registerAuthAndAccessRoutes,
      registerTtsRoutes: () => {}, registerNotificationRoutes: () => {}, registerOpenChamberRoutes: () => {},
    });
    bootstrap.setupBaseRoutes(app, { basePath: '/code', humanAuth, tunnelAuthController,
      process, runtimeName: 'test', openchamberVersion: 'fixture', sessionRuntime: {},
      gracefulShutdown: async () => {}, getHealthSnapshot: () => ({}),
    });
    const session = await request(app).get('/code/api/auth/get-session').set('Origin', origin).expect(200);
    assert.equal(session.body, null);
    await request(app).get('/api/auth/get-session').set('Origin', origin).expect(404);
    const signIn = await request(app).post('/code/api/auth/sign-in/social').set('Origin', origin)
      .send({ provider: 'google', callbackURL: publicBase + '/' }).expect(200);
    assert.equal(new URL(signIn.body.url).searchParams.get('redirect_uri'), publicBase + '/api/auth/callback/google');
  } finally {
    humanAuth.dispose();
    database.close();
  }
});
