import { describe, expect, it } from 'bun:test';
import express from 'express';
import request from 'supertest';
import { registerOrgEntryRoutes } from './org-entry.js';

const app = () => {
  const server = express();
  registerOrgEntryRoutes(server);
  server.get(/.*/, (_req, res) => res.send('app'));
  return server;
};

describe('organization entry URL', () => {
  it('opens the app from /smartypants, with or without a trailing slash', async () => {
    for (const path of ['/smartypants', '/smartypants/']) {
      const response = await request(app()).get(path);
      expect(response.status).toBe(302);
      expect(response.headers.location).toBe('/');
      expect(response.headers['cache-control']).toBe('no-store');
    }
  });

  it('keeps the query string', async () => {
    const response = await request(app()).get('/smartypants?session=abc&x=1');
    expect(response.headers.location).toBe('/?session=abc&x=1');
  });

  it('leaves other paths to the app', async () => {
    for (const path of ['/', '/smartypantsx', '/smartypants/other', '/api/smartypants']) {
      const response = await request(app()).get(path);
      expect(response.status).toBe(200);
    }
  });
});
