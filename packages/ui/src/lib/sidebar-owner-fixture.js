import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { betterAuth } from 'better-auth';
import { testUtils } from 'better-auth/plugins';
import { z } from 'zod';
import { createHumanAuth } from '../../../web/server/lib/ui-auth/human-auth.js';
import { registerHumanSidebarViewRoutes } from '../../../web/server/lib/ui-auth/human-sidebar-view.js';

const view = z.object({ owner: z.object({ issuer: z.string(), subject: z.string() }),
  projects: z.record(z.string(), z.boolean()), groups: z.record(z.string(), z.boolean()) });
const patch = view.partial({ projects: true, groups: true });
const gate = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve: () => resolve() };
};

/** Private real auth/HTTP fixture. It never contacts OAuth or a provider. */
export async function createSidebarOwnerFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'sidebar-owner-'));
  const database = new DatabaseSync(`${directory}/auth.sqlite`);
  const nativeFetch = globalThis.fetch;
  const app = express();
  const server = app.listen(0, '127.0.0.1');
  await new Promise(done => server.once('listening', done));
  const address = z.object({ port: z.number() }).parse(server.address());
  const baseURL = `http://127.0.0.1:${address.port}`;
  const human = await createHumanAuth({ database, baseURL,
    secret: 'isolated-sidebar-fixture-secret-at-least-32-characters',
    googleClientId: 'fixture', googleClientSecret: 'fixture', allowedDomains: ['example.test'] });
  const fixtureAuth = betterAuth({ ...human.auth.options,
    user: { ...human.auth.options.user, validateUserInfo: undefined }, plugins: [testUtils()] });
  const helpers = (await fixtureAuth.$context).test;
  const people = await Promise.all(['a', 'b'].map(name => helpers.saveUser(helpers.createUser({
    name, email: `${name}@example.test`, emailVerified: true }))));
  const subjects = people.map(person => person.id);
  const cookies = await Promise.all(people.map(async person => (await helpers.getAuthHeaders({ userId: person.id })).get('cookie') ?? ''));
  const fixture = { baseURL, subjects, cookie: cookies[0], gets: 0, requests: [],
    heldPatch: undefined, heldRead: undefined, refuse: false,
    person(index) { fixture.cookie = cookies[index]; },
    gate,
    fetch(input, init) {
      const headers = new Headers(init?.headers);
      headers.set('Cookie', fixture.cookie); headers.set('Origin', baseURL);
      return nativeFetch(input, { ...init, headers });
    },
    async stored(index) {
      const response = await nativeFetch(`${baseURL}/api/config/sidebar-view`, { headers: { Cookie: cookies[index] } });
      if (!response.ok) throw new Error(`Private fixture read failed ${response.status}`);
      return view.parse(await response.json());
    },
    async seed(index, projects) {
      const response = await nativeFetch(`${baseURL}/api/config/sidebar-view`, { method: 'PATCH',
        headers: { Cookie: cookies[index], Origin: baseURL, 'Content-Type': 'application/json' },
        body: JSON.stringify({ owner: { issuer: baseURL, subject: subjects[index] }, projects }) });
      if (!response.ok) throw new Error(`Private fixture seed failed ${response.status}`);
    },
    async close() {
      human.dispose();
      await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
      database.close();
    },
  };
  app.use(express.json());
  app.use('/api', (req, res, next) => human.protect(req, res, next));
  app.use('/api/config/sidebar-view', async (req, res, next) => {
    if (req.method === 'PATCH') {
      fixture.requests.push(patch.parse(req.body));
      await fixture.heldPatch?.promise;
      if (fixture.refuse) return res.status(500).json({ error: 'fixture storage failure' });
    } else {
      fixture.gets++;
      await fixture.heldRead?.promise;
    }
    next();
  });
  registerHumanSidebarViewRoutes(app, { express, humanAuth: human });
  return fixture;
}
