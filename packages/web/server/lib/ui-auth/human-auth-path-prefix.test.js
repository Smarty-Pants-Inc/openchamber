import assert from 'node:assert/strict';
import { test } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createHumanAuth } from './human-auth.js';

test('public auth URL path yields the prefixed Google callback while internal routes stay stripped', async () => {
  const database = new DatabaseSync(':memory:');
  const origin = 'http://localhost:43210';
  const publicBase = origin + '/code';
  const human = await createHumanAuth({ database, baseURL: publicBase,
    secret: 'fixture-only-secret-thirty-two-characters', googleClientId: 'fixture-client',
    googleClientSecret: 'fixture-secret', allowedDomains: ['example.test'] });
  try {
    assert.equal(human.auth.options.baseURL, publicBase + '/api/auth');
    assert.equal(human.auth.options.basePath, '/api/auth');
    const start = await human.auth.api.signInSocial({ body: { provider: 'google', callbackURL: publicBase + '/' } });
    assert.equal(new URL(start.url).searchParams.get('redirect_uri'), publicBase + '/api/auth/callback/google');

    const session = await human.auth.handler(new Request(publicBase + '/api/auth/get-session', { headers: { origin } }));
    assert.equal(session.status, 200);
    assert.equal(await session.json(), null);
  } finally {
    human.dispose();
    database.close();
  }
});
