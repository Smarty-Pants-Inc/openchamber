import { expect, test } from 'bun:test';
import { loadSmarties, loadSmartyFeed, sendSmartyMessage, SmartiesRequestError } from './smarties';

// smarty-code#1407: the client parses the gateway's /api/smarties answers once; a missing route or a person without a
// Smarty is "unavailable", any other failure throws (never an empty list).
// Bodies are literal wire JSON (some deliberately malformed), so they go in as text.
const json = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'application/json' } });
const calls: { url: string; init: RequestInit }[] = [];
const fake = (response: () => Response) => async (url: string, init: RequestInit) => { calls.push({ url, init }); return response(); };

test('the list puts the own Smarty first', async () => {
  const result = await loadSmarties(fake(() => json(JSON.stringify({ me: 'kate', smarties: [
    { id: 'paul', label: 'Paul’s Smarty', own: false, writable: false }, { id: 'kate', label: 'Kate’s Smarty', own: true, writable: true }] }))));
  expect(result.state === 'ready' && result.smarties.map(s => s.id)).toEqual(['kate', 'paul']);
  expect(calls.at(-1)?.url).toBe('/api/smarties');
});

test('404, 403 and an empty list are unavailable; a 500 or a malformed body throws', async () => {
  expect(await loadSmarties(fake(() => new Response('Not Found', { status: 404 })))).toEqual({ state: 'unavailable' });
  expect(await loadSmarties(fake(() => json(JSON.stringify({}), 403)))).toEqual({ state: 'unavailable' });
  expect(await loadSmarties(fake(() => json(JSON.stringify({ me: 'x', smarties: [] }))))).toEqual({ state: 'unavailable' });
  expect(loadSmarties(fake(() => json(JSON.stringify({}), 500)))).rejects.toBeInstanceOf(SmartiesRequestError);
  expect(loadSmarties(fake(() => json(JSON.stringify({ me: 'paul', smarties: [{ id: 'paul' }] }))))).rejects.toThrow();
});

test('the feed reads the last blocks, or those after an offset; a send posts text and clientId', async () => {
  const feed = { blocks: [{ id: 'b1', author: 'org', at: '11:55 PM ET', text: 'Hi' }], offset: 10 };
  expect(await loadSmartyFeed('paul', undefined, fake(() => json(JSON.stringify(feed))))).toEqual(feed);
  expect(calls.at(-1)?.url).toBe('/api/smarties/paul/feed');
  await loadSmartyFeed('paul', 10, fake(() => json(JSON.stringify(feed))));
  expect(calls.at(-1)?.url).toBe('/api/smarties/paul/feed?after=10');
  expect(loadSmartyFeed('kate', undefined, fake(() => json(JSON.stringify({}), 403)))).rejects.toBeInstanceOf(SmartiesRequestError);
  await sendSmartyMessage('paul', 'Ship it', 'msg_1', fake(() => json(JSON.stringify({ accepted: true }), 202)));
  expect(calls.at(-1)).toMatchObject({ url: '/api/smarties/paul/messages', init: { method: 'POST', body: JSON.stringify({ text: 'Ship it', clientId: 'msg_1' }) } });
  expect(sendSmartyMessage('kate', 'x', 'msg_2', fake(() => json(JSON.stringify({}), 502)))).rejects.toBeInstanceOf(SmartiesRequestError);
});
