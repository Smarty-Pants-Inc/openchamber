import { expect, test } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createBasePathMiddleware, normalizeBasePath, stripBasePathFromUrl } from './base-path.js';

test('mounted requests are stripped for the existing app routes and root stays unclaimed', async () => {
  const app = express();
  app.use(createBasePathMiddleware('/code', ['/api/auth']));
  app.get('/', (_req, res) => res.send('app root'));
  app.get(/.*/, (req, res) => res.json({ path: req.path }));

  await request(app).get('/code').expect(200, 'app root');
  await request(app).get('/code/api/auth/callback/google?state=x').expect(200, { path: '/code/api/auth/callback/google' });
  await request(app).get('/code/api/version').expect(200, { path: '/api/version' });
  await request(app).get('/').expect(404, 'Not found');
  await request(app).get('/code-other').expect(404, 'Not found');
});

test('raw WebSocket upgrade paths are stripped before their route owners run', () => {
  expect(stripBasePathFromUrl('/code/api/global/event/ws?oc_url_token=x', '/code'))
    .toBe('/api/global/event/ws?oc_url_token=x');
  expect(stripBasePathFromUrl('/api/global/event/ws', '/code')).toBe(null);
  expect(stripBasePathFromUrl('/api/global/event/ws', '')).toBe('/api/global/event/ws');
});

test('base path accepts only canonical absolute mount paths', () => {
  expect(normalizeBasePath(undefined)).toBe('');
  expect(normalizeBasePath('/code')).toBe('/code');
  for (const invalid of ['/code/', '//code', '/code/../admin', '/code?x=1', 'code']) {
    expect(() => normalizeBasePath(invalid)).toThrow();
  }
});
