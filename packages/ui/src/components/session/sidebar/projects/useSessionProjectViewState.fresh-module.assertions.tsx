import { expect } from 'bun:test';
import { freshModuleFixture, targetGroup } from './useSessionProjectViewState.fresh-module.fixture';

export async function manualFirstMount(kind: 'project' | 'group') {
  const f = await freshModuleFixture();
  try {
    expect(f.importedScopeRetired).toBe(true);
    await f.render();
    expect(f.reads).toHaveLength(1);
    expect(f.reads[0]!.released).toBe(false);
    // No reveal, second mount, unrelated rerender, or bulk action can refresh
    // the first-render admission before this sole explicit manual choice.
    expect(f.renders).toBe(1);
    expect(f.view.bulkActionsReady).toBe(false);
    expect(f.view.state.collapsedProjects.has('p')).toBe(true);
    expect(f.view.state.collapsedGroups.has(targetGroup)).toBe(false);
    await f.click(kind);
    // Baseline must fail HERE, not because the loader or fixture failed.
    expect(kind === 'project' ? f.view.state.collapsedProjects.has('p') : f.view.state.collapsedGroups.has(targetGroup))
      .toBe(kind === 'group');
    expect(f.mutations).toEqual([kind === 'project' ? { projects: { p: false } } : { groups: { [targetGroup]: true } }]);
    expect(f.reads).toHaveLength(1);
    expect(f.reads[0]!.released).toBe(false);
    expect(f.writes).toEqual([]);
    expect(f.failures).toBe(0);
    await f.release();
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]!.method).toBe('PATCH');
    expect(f.writes[0]!.subject).toBe('person-a');
    expect(JSON.parse(f.writes[0]!.body)).toEqual({ owner: f.owner,
      ...(kind === 'project' ? { projects: { p: false } } : { groups: { [targetGroup]: true } }),
    });
    expect(f.persisted()).toEqual(kind === 'project'
      ? { projects: { p: false }, groups: { unrelated: true } }
      : { projects: {}, groups: { unrelated: true, [targetGroup]: true } });
    expect(kind === 'project' ? f.view.state.collapsedProjects.has('p') : f.view.state.collapsedGroups.has(targetGroup))
      .toBe(kind === 'group');
    expect(f.failures).toBe(0);
  } finally { await f.close(); }
}
