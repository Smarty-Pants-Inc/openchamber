import assert from 'node:assert/strict';

/** Compare the real Better Auth response with this request's generic, sanitized policy context. */
export async function assertAuthGetSession(call, person, latestObservation) {
  const response = await call('/api/auth/get-session', { Cookie: person.cookie });
  assert.equal(response.status, 200);
  assert.equal(response.headers['x-policy-fixture'], 'human');
  assert.ok(response.headers['content-type'].includes('application/json'));
  const body = JSON.parse(response.body);
  const metadata = {
    id: body.session.id,
    createdAt: new Date(body.session.createdAt).getTime(),
    expiresAt: new Date(body.session.expiresAt).getTime(),
  };
  assert.deepEqual(latestObservation(), metadata);
  assert.equal(metadata.id, person.session.id);
  assert.equal(metadata.createdAt, new Date(person.session.createdAt).getTime());
  assert.equal(metadata.expiresAt, new Date(person.session.expiresAt).getTime());
  // Do not print the response, profile, session ID, cookie or token.
  console.log(`AUTH_GET_SESSION_CACHE=${response.headers['cache-control'] ?? 'absent'}; body/context metadata equal`);
}
