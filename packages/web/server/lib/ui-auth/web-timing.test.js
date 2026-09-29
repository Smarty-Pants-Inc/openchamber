import { describe, expect, it } from 'vitest';
import { startWebTiming, webTimingHeaders } from './web-timing.js';

describe('web timing stamps (smarty-code#827)', () => {
  it('stamps when the request arrived and how long its person check took; forwards only numbers', () => {
    let t = 1_000; const req = {};
    const done = startWebTiming(req, () => t); t += 3_900; done();
    expect(webTimingHeaders(req)).toEqual({ 'x-smarty-web-received': '1000', 'x-smarty-web-auth': '3900' });
    startWebTiming(req, () => 9_999)(); // A second check keeps the first arrival.
    expect(webTimingHeaders(req)['x-smarty-web-received']).toBe('1000');
  });
  it('a request with no stamps (or a browser-supplied one) forwards nothing of its own', () => {
    expect(webTimingHeaders({ headers: { 'x-smarty-web-received': '1' } })).toEqual({});
    expect(webTimingHeaders({ smartyWebReceived: 'soon', smartyWebAuthMs: -1 })).toEqual({});
  });
  it('puts its own stamps on the request headers the proxy forwards, replacing a browser-supplied one', () => {
    let t = 5_000; const req = { headers: { 'x-smarty-web-received': '1', 'x-smarty-web-auth': '99999', cookie: 'c' } };
    const done = startWebTiming(req, () => t); t += 120; done();
    expect(req.headers).toEqual({ cookie: 'c', 'x-smarty-web-received': '5000', 'x-smarty-web-auth': '120' });
  });
});
