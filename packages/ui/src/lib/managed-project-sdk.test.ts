import { afterEach, expect, spyOn, test } from 'bun:test';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { opencodeClient } from './opencode/client';
import { refreshManagedProjects } from './managed-project-refresh';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

const projects = useProjectsStore.getState(), sessions = useGlobalSessionsStore.getState(), ui = useSessionUIStore.getState();
const network = spyOn(globalThis, 'fetch');
const getClient = spyOn(opencodeClient, 'getSdkClient');
afterEach(() => {
  network.mockRestore(); getClient.mockRestore();
  useProjectsStore.setState(projects, true); useGlobalSessionsStore.setState(sessions, true); useSessionUIStore.setState(ui, true);
});

test('actual SDK preserves the unqualified catalog marker; marked empty and failed reads stay distinct', async () => {
  const paths: string[] = [];
  let failed = false;
  network.mockImplementation(async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    if (url.origin !== 'http://synthetic.invalid') throw new Error('No external network');
    paths.push(url.pathname);
    expect(url.searchParams.has('directory')).toBe(false);
    expect(request.headers.has('x-opencode-directory')).toBe(false);
    if (url.pathname === '/project') return failed
      ? Response.json({ error: 'unavailable' }, { status: 503 })
      : Response.json([], { headers: { 'X-Smarty-Code-Catalog': 'managed-v1' } });
    if (url.pathname === '/experimental/session') return Response.json([]);
    throw new Error(`Unexpected SDK path: ${url.pathname}`);
  });
  getClient.mockReturnValue(createOpencodeClient({ baseUrl: 'http://synthetic.invalid' }));
  useProjectsStore.setState({ managedCatalogAdmitted: false, managedCatalogStatus: 'unknown', managedRows: null, managedProjects: null });
  await refreshManagedProjects(true);
  expect(useProjectsStore.getState().managedCatalogAdmitted).toBe(true);
  expect(useProjectsStore.getState().managedCatalogStatus).toBe('ready');
  expect(useProjectsStore.getState().managedRows).toEqual([]);
  expect(paths).toEqual(['/project', '/experimental/session']);
  failed = true;
  await refreshManagedProjects(true);
  expect(useProjectsStore.getState().managedCatalogStatus).toBe('unavailable');
  expect(useProjectsStore.getState().managedRows).toEqual([]);
  expect(paths).toEqual(['/project', '/experimental/session', '/project']);
});
