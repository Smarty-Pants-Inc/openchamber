import { expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

// smarty-code#126: on mobile the model controls (and their Voice call) sit in a hidden sheet host, so the footer shows
// the call control itself, for an ordinary Pi session only.
const sessions = new Map<string, Record<string, unknown>>();
mock.module('@/sync/sync-context', () => ({ useSession: (id: string) => sessions.get(id) }));
mock.module('@/sync/session-ui-store', () => ({ useSessionUIStore: (pick: (state: unknown) => unknown) =>
  pick({ getDirectoryForSession: () => '/stored' }) }));
mock.module('./PiVoiceControl', () => ({ PiVoiceControl: ({ sessionId, directory }: { sessionId: string; directory: string }) =>
  <button type="button">{`voice ${sessionId} ${directory}`}</button> }));
const { SessionVoiceCall } = await import('./SessionVoiceCall');

const ordinary = { generation: 'g', sequence: 1, model: { providerID: 'p', modelID: 'm', name: 'M' }, thinkingLevel: 'high' };
const base = { slug: 's', projectID: 'p', title: 'T', version: '1', time: { created: 1, updated: 1 } };

test('an ordinary Pi session gets the Voice call control, with the session\'s own directory', () => {
  sessions.set('pi', { ...base, id: 'pi', directory: '/project', ordinary });
  expect(renderToStaticMarkup(<SessionVoiceCall sessionId="pi" directory="/other" />)).toContain('voice pi /project');
});

test('a session that is not an ordinary Pi session, or not loaded, shows nothing', () => {
  sessions.set('plain', { ...base, id: 'plain', directory: '/project' });
  expect(renderToStaticMarkup(<SessionVoiceCall sessionId="plain" />)).toBe('');
  expect(renderToStaticMarkup(<SessionVoiceCall sessionId="missing" />)).toBe('');
});
