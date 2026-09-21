import { describe, expect, it } from 'vitest';

import {
  applyForwardProxyResponseHeaders,
  collectForwardProxyHeaders,
  exposedProxyResponseHeaders,
  shouldForwardProxyResponseHeader,
} from './proxy-headers.js';

describe('OpenCode proxy header handling', () => {
  it('drops accept-encoding from forwarded request headers', () => {
    const headers = collectForwardProxyHeaders({
      accept: 'application/json',
      'accept-encoding': 'gzip, deflate, br',
      connection: 'keep-alive',
    });

    expect(headers.accept).toBe('application/json');
    expect(headers['accept-encoding']).toBeUndefined();
  });

  it('replaces client authorization with managed OpenCode auth', () => {
    const headers = collectForwardProxyHeaders(
      { authorization: 'Bearer oc_client_stale-ui-token' },
      { Authorization: 'Bearer managed-opencode-token' },
    );

    expect(headers.Authorization).toBe('Bearer managed-opencode-token');
    expect(headers['authorization']).toBeUndefined();
  });

  it('drops client authorization when upstream has no managed auth', () => {
    const headers = collectForwardProxyHeaders({
      accept: 'application/json',
      authorization: 'Bearer oc_client_stale-ui-token',
    });

    expect(headers['authorization']).toBeUndefined();
    expect(headers.Authorization).toBeUndefined();
    expect(headers.accept).toBe('application/json');
  });

  it('preserves the accepted ordinary view in requests and view/cursor response headers', () => {
    const view = `ov2_${'a'.repeat(64)}`;
    expect(collectForwardProxyHeaders({ 'x-smarty-ordinary-view': view }))
      .toEqual({ 'x-smarty-ordinary-view': view });
    const applied = new Map();
    applyForwardProxyResponseHeaders(new Headers({
      'x-smarty-ordinary-view': view,
      'x-next-cursor': 'older-page',
    }), { setHeader: (key, value) => applied.set(key, value) });
    expect(applied.get('x-smarty-ordinary-view')).toBe(view);
    expect(applied.get('x-next-cursor')).toBe('older-page');
  });

  it('forwards and exposes the managed catalog marker without inventing absent authority', () => {
    const applied = new Map();
    const response = { setHeader: (key, value) => applied.set(key, value) };
    applyForwardProxyResponseHeaders(new Headers({ 'X-Smarty-Code-Catalog': 'managed-v1' }), response);
    expect(applied.get('x-smarty-code-catalog')).toBe('managed-v1');
    expect(exposedProxyResponseHeaders.split(', ')).toEqual(['x-next-cursor', 'x-smarty-code-catalog']);
    applied.clear();
    applyForwardProxyResponseHeaders(new Headers({ 'content-type': 'application/json' }), response);
    expect(applied.has('x-smarty-code-catalog')).toBe(false);
  });

  it('drops forged actors and Better Auth cookies without changing legacy cookies', () => {
    expect(collectForwardProxyHeaders({
      'X-Smarty-Human-Identity': 'forged',
      Cookie: 'legacy=value; __Secure-better-auth.session_token=private; better-auth.session_data=private',
    })).toEqual({ cookie: 'legacy=value' });
    expect(collectForwardProxyHeaders({ cookie: '__Host-better-auth.session_token=private' })).toEqual({});
  });

  it('forwards only the resolved actor with managed upstream authentication', () => {
    const actor = { version: 1, issuer: 'https://code.smartypants.ai', subject: 'opaque_user', name: 'A Person' };
    const headers = collectForwardProxyHeaders({
      authorization: 'Bearer client', cookie: 'legacy=value; better-auth.session_token=private',
      'x-smarty-human-identity': 'forged', 'x-smarty-ordinary-view': 'accepted-view',
    }, { Authorization: 'Bearer managed' }, actor);
    expect(headers).toEqual({ Authorization: 'Bearer managed',
      'x-smarty-human-identity': Buffer.from(JSON.stringify(actor)).toString('base64url'),
      'x-smarty-ordinary-view': 'accepted-view' });
  });

  it('refuses actor forwarding without upstream authentication', () => {
    expect(() => collectForwardProxyHeaders({}, {}, { subject: 'opaque_user' }))
      .toThrow('Human identity forwarding requires upstream authentication');
  });

  it('drops content-encoding from forwarded response headers', () => {
    expect(shouldForwardProxyResponseHeader('content-encoding')).toBe(false);
    expect(shouldForwardProxyResponseHeader('Content-Encoding')).toBe(false);
  });

  it('drops transfer-encoding from forwarded response headers', () => {
    expect(shouldForwardProxyResponseHeader('transfer-encoding')).toBe(false);
    expect(shouldForwardProxyResponseHeader('Transfer-Encoding')).toBe(false);
  });

  it('still keeps ordinary response headers', () => {
    expect(shouldForwardProxyResponseHeader('content-type')).toBe(true);
    expect(shouldForwardProxyResponseHeader('etag')).toBe(true);
  });

  it('applies upstream response headers to express response without content-encoding', () => {
    const applied = [];
    const response = {
      setHeader(key, value) {
        applied.push([key, value]);
      },
    };

    applyForwardProxyResponseHeaders(
      new Headers({
        'content-type': 'application/json',
        etag: 'W/"abc"',
        'content-encoding': 'gzip',
      }),
      response,
    );

    expect(applied).toEqual([
      ['content-type', 'application/json'],
      ['etag', 'W/"abc"'],
    ]);
  });
});
