// Declarative input and expected public list contract, not a sanitizer implementation.
export const retained = {
  slug: 'ownership', projectID: 'project-1154', workspaceID: 'workspace-1154',
  directory: '/fixture/1154', path: '/fixture/1154', parentID: '', title: 'Ownership fixture',
  agent: 'build', model: { id: 'stock-model', providerID: 'stock-provider', variant: 'low' },
  version: '1', time: { created: 1, updated: 2 }, cost: 0, tokens: { input: 10, output: 20 },
  share: { url: 'https://fixture.invalid/share' }, metadata: { custom: 'kept' },
  project: { id: 'project-1154', worktree: '/fixture/1154' },
  herdrState: 'idle', herdrNoIdentity: false, herdrSuccessor: null,
  ordinaryReloading: false, ordinaryCodeMade: false,
};
export const nativeState = {
  generation: 'native-generation-1154', sequence: 7,
  model: { providerID: 'native-provider', modelID: 'native-model', name: 'Native model 1154' },
  thinkingLevel: 'high',
};
const unavailable = { generation: null, sequence: 0, model: null, thinkingLevel: null };
const summary = { additions: 5, deletions: 3, files: 2 };
const revert = { messageID: 'message-1154', partID: 'part-1154' };
const malformed = { ...nativeState, sequence: -1 };
export const cohort = [
  { id: 'native-full', fields: { nativeRuntime: 'ordinary', ordinary: nativeState }, state: nativeState, branch: 'ordinary' },
  { id: 'native-summary', fields: { nativeRuntime: 'ordinary' }, state: unavailable, branch: 'ordinary' },
  { id: 'native-malformed', fields: { nativeRuntime: 'ordinary', ordinary: malformed }, state: unavailable, branch: 'ordinary' },
  { id: 'native-state-only', fields: { ordinary: nativeState }, state: nativeState, branch: 'ordinary' },
  { id: 'stock', fields: {}, state: undefined, branch: 'configured' },
];
export const upstreamRows = cohort.map(({ id, fields }) => ({
  ...retained, id, ...fields,
  summary: { ...summary, diffs: [{ patch: 'not for lists' }] },
  revert: { ...revert, snapshot: 'not for lists', diff: 'not for lists', extra: true },
  permission: [{ permission: 'write', action: 'deny', pattern: '*' }],
  unlistedExtra: { mustNotPass: true },
}));
export const expectedRows = cohort.map(({ id, fields }) => ({ ...retained, id, ...fields, summary, revert }));
export const routes = ['/api/session', '/api/experimental/session'];
