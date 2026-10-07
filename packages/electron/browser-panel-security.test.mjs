import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldAllowBrowserPanelCertificateError } from './browser-panel-security.mjs';

test('allows untrusted certificate authorities for loopback HTTPS pages', () => {
  for (const url of [
    'https://localhost:58580/',
    'https://127.0.0.1:58580/',
    'https://[::1]:58580/',
  ]) {
    assert.equal(shouldAllowBrowserPanelCertificateError({
      url,
      error: 'net::ERR_CERT_AUTHORITY_INVALID',
    }), true);
  }
});

test('keeps certificate validation for non-loopback pages', () => {
  for (const url of [
    'https://example.com/',
    'https://localhost.example.com/',
    'https://0.0.0.0:58580/',
  ]) {
    assert.equal(shouldAllowBrowserPanelCertificateError({
      url,
      error: 'net::ERR_CERT_AUTHORITY_INVALID',
    }), false);
  }
});

test('does not bypass other certificate failures or malformed URLs', () => {
  assert.equal(shouldAllowBrowserPanelCertificateError({
    url: 'https://localhost:58580/',
    error: 'net::ERR_CERT_DATE_INVALID',
  }), false);
  assert.equal(shouldAllowBrowserPanelCertificateError({
    url: 'not a url',
    error: 'net::ERR_CERT_AUTHORITY_INVALID',
  }), false);
});

// openchamber#554 round 6: a window on a remote host must not reach this machine.
test('a remote window\'s panel cannot reach any spelling of this machine', async () => {
  const { shouldBlockBrowserPanelRequest } = await import('./browser-panel-security.mjs');
  for (const url of [
    'http://localhost:3000/', 'http://LOCALHOST./', 'http://app.localhost/', 'ws://localhost:5173/hmr',
    'http://127.0.0.1/', 'http://127.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://127.255.0.9:8080/',
    'http://0.0.0.0:3000/', 'http://0/', 'http://[::1]/', 'http://[0:0:0:0:0:0:0:1]/', 'http://[::]/',
    'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://[::ffff:0.0.0.0]/',
    'file:///etc/passwd', 'not a url',
  ]) {
    assert.equal(shouldBlockBrowserPanelRequest({ url, embedderIsLocal: false }), true, url);
    // Unknown embedder fails closed.
    assert.equal(shouldBlockBrowserPanelRequest({ url, embedderIsLocal: undefined }), true, url);
  }
});

test('a remote window\'s panel still reaches other hosts, and the local app reaches loopback', async () => {
  const { shouldBlockBrowserPanelRequest } = await import('./browser-panel-security.mjs');
  for (const url of [
    'https://example.com/', 'http://localhost.example.com/', 'http://128.0.0.1/', 'http://10.0.0.5/',
    'http://[::ffff:808:808]/', 'http://[2001:db8::1]/', 'about:blank', 'data:text/html,hi',
  ]) {
    assert.equal(shouldBlockBrowserPanelRequest({ url, embedderIsLocal: false }), false, url);
  }
  for (const url of ['http://localhost:3000/', 'http://127.0.0.1/', 'file:///tmp/x.html']) {
    assert.equal(shouldBlockBrowserPanelRequest({ url, embedderIsLocal: true }), false, url);
  }
});
