import { rejects } from 'node:assert/strict';
import { afterEach, expect, spyOn, test } from 'bun:test';
import { opencodeClient } from '@/lib/opencode/client';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from './session-ui-store';
import { nativeDraftFixture, directory, draft } from './native-draft-fixture';
import { prepareNativeDraft, preparedNativeDraft } from './native-draft-creation';
import { startNativeDraft } from './native-draft-start';

let fixture: ReturnType<typeof nativeDraftFixture> | undefined;
afterEach(() => { fixture?.dispose(); fixture = undefined; });
for (const override of [directory, '']) test(`actual prepared eagerly reads selected project path even with override ${JSON.stringify(override)}`, async () => {
  const f = fixture = nativeDraftFixture();
  let pathReads = 0;
  const project = { id: 'a', get path() { pathReads++; return '/project-fallback'; } };
  useProjectsStore.setState({ projects: [project] });
  useSessionUIStore.setState({ newSessionDraft: { ...draft, directoryOverride: override } });
  const fallback = spyOn(opencodeClient, 'getDirectory'); pathReads = 0;
  try {
    await rejects(preparedNativeDraft(useSessionUIStore.getState().newSessionDraft), { code: override ? 'required' : 'target' });
    expect(pathReads).toBe(1); expect(fallback).not.toHaveBeenCalled();
    expect(f.requests.filter(r => new URL(r.url).pathname.endsWith('/global/health'))).toHaveLength(override ? 1 : 0);
    expect(f.creates()).toHaveLength(0);
  } finally { fallback.mockRestore(); }
});

for (const override of [directory, '']) test(`actual start short-circuits project and SDK path getters on non-null override ${JSON.stringify(override)}`, async () => {
  const f = fixture = nativeDraftFixture(); let pathReads = 0;
  const project = { id: 'a', get path() { pathReads++; return '/project-fallback'; } };
  useProjectsStore.setState({ projects: [project] });
  useSessionUIStore.setState({ newSessionDraft: { ...draft, directoryOverride: override } });
  f.handlers.health = async () => Response.json({ healthy: true }); // Actual legacy support response, no native effects.
  const fallback = spyOn(opencodeClient, 'getDirectory'); pathReads = 0;
  try {
    await startNativeDraft([]);
    expect(pathReads).toBe(0); expect(fallback).not.toHaveBeenCalled(); expect(f.creates()).toHaveLength(0);
    expect(f.requests.filter(r => new URL(r.url).pathname.endsWith('/global/health'))).toHaveLength(override ? 1 : 0);
  } finally { fallback.mockRestore(); }
});

test('actual explicit creation does not read project path for a stock raw override', async () => {
  const f = fixture = nativeDraftFixture(); let pathReads = 0;
  useProjectsStore.setState({ projects: [{ id: 'a', get path() { pathReads++; return '/project-fallback'; } }] });
  pathReads = 0; await prepareNativeDraft();
  expect(pathReads).toBe(0); expect(f.creates()).toHaveLength(1);
  expect(new URL(f.creates()[0].url).searchParams.get('directory')).toBe(directory);
});
