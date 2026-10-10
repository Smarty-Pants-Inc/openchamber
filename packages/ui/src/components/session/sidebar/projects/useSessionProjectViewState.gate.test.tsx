import { expect, test } from 'bun:test';
import { act } from 'react';
import { capturePersonalSidebarAdmission, setPersonalSidebarView } from '@/lib/sidebar-view';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { initialReadFixture, settle, targetGroup, unrelatedGroup } from './useSessionProjectViewState.initial-read.fixture';

class UnreadableSet extends Set<string> {
  override [Symbol.iterator](): SetIterator<string> { throw new Error('Blocked bulk input was enumerated'); }
  override has(): boolean { throw new Error('Blocked bulk input was inspected'); }
}

test('all five personal bulk entrypoints reject before updater execution or input enumeration', async () => {
  const f = await initialReadFixture();
  try {
    await f.render();
    expect(f.view.bulkActionsReady).toBe(false);
    const before = f.view.state;
    let updates = 0;
    await act(async () => {
      const actions = f.view.actions;
      actions.collapseAllProjects();
      actions.expandAllProjects();
      actions.setCollapsedProjects(previous => { updates++; return previous; });
      actions.setCollapsedGroups(previous => { updates++; return previous; });
      actions.setCollapsedProjects(new UnreadableSet());
      actions.setCollapsedGroups(new UnreadableSet());
      actions.scheduleCollapsedProjectsPersist(new UnreadableSet());
    });
    await settle();
    expect(updates).toBe(0);
    expect(f.writes).toEqual([]);
    expect(f.view.state).toBe(before);
    await f.release();
    expect(f.view.bulkActionsReady).toBe(true);
    await act(async () => f.view.actions.setCollapsedGroups(previous => {
      updates++;
      const next = new Set(previous); next.delete(targetGroup); return next;
    }));
    await settle();
    expect(updates).toBe(1);
    expect(f.persisted().groups[targetGroup]).toBe(false);
    expect(f.persisted().groups[unrelatedGroup]).toBe(true);
  } finally { await f.close(); }
});

test('manual toggles keep their healthy initial admission while bulk choices are refused', async () => {
  const f = await initialReadFixture();
  try {
    await f.render();
    await act(async () => { f.view.actions.toggleProject('p'); f.view.actions.toggleGroup(targetGroup); });
    await settle();
    expect(f.view.state.collapsedProjects.has('p')).toBe(false);
    expect(f.view.state.collapsedGroups.has(targetGroup)).toBe(true);
    expect(f.writes).toEqual([]);
    await f.release();
    expect(f.persisted().projects.p).toBe(false);
    expect(f.persisted().groups[targetGroup]).toBe(true);
    expect(f.persisted().groups[unrelatedGroup]).toBe(true);
  } finally { await f.close(); }
});

test('a captured old admission cannot enumerate or save a payload under the next person', async () => {
  const f = await initialReadFixture();
  try {
    await f.render(); await f.release();
    const admission = capturePersonalSidebarAdmission();
    const actions = f.view.actions;
    await f.switchPerson();
    expect(f.view.bulkActionsReady).toBe(false);
    let updates = 0;
    await act(async () => actions.setCollapsedProjects(previous => { updates++; return previous; }));
    expect(updates).toBe(0);
    const patch = { get projects(): Record<string, boolean> { throw new Error('Retired payload inspected'); } };
    await expect(setPersonalSidebarView(patch, admission)).rejects.toThrow('admission retired');
    await f.release(1);
    expect(f.view.bulkActionsReady).toBe(true);
    await expect(setPersonalSidebarView({ groups: { [targetGroup]: false } }, admission)).rejects.toThrow('admission retired');
    expect(f.writes).toEqual([]);
    expect(f.persisted('person-a').groups[targetGroup]).toBe(true);
    expect(f.persisted('person-b').groups[targetGroup]).toBe(true);
    const enabled = await f.menuItem();
    await act(async () => enabled.click()); await settle();
    expect(f.persisted('person-b').groups[targetGroup]).toBe(false);
    expect(f.persisted('person-a').groups[targetGroup]).toBe(true);
  } finally { await f.close(); }
});

test('hydrated actual Collapse all clears displayed subgroup overrides without touching q', async () => {
  const f = await initialReadFixture();
  try {
    await f.render(); await f.release();
    const collapse = await f.menuItem('Collapse all');
    expect(collapse.getAttribute('aria-disabled')).not.toBe('true');
    await act(async () => collapse.click()); await settle();
    expect(f.view.state.collapsedProjects.has('p')).toBe(true);
    expect(f.view.state.collapsedGroups).toEqual(new Set([unrelatedGroup]));
    expect(f.persisted()).toEqual({ projects: { p: true }, groups: { [targetGroup]: false, [unrelatedGroup]: true } });
    expect(f.writes).toHaveLength(1);
    expect(JSON.parse(f.writes[0]!.body)).toEqual({ owner: f.owner, projects: { p: true }, groups: { [targetGroup]: false } });
  } finally { await f.close(); }
});

test('runtime reset immediately revokes bulk readiness until its own GET completes', async () => {
  const f = await initialReadFixture();
  try {
    await f.render(); await f.release();
    const admission = capturePersonalSidebarAdmission();
    await act(async () => switchRuntimeEndpoint({ apiBaseUrl: 'https://next-runtime.example.test', runtimeKey: 'gate-next' }));
    await settle();
    expect(f.reads).toHaveLength(2);
    expect(f.view.bulkActionsReady).toBe(false);
    expect((await f.menuItem()).getAttribute('aria-disabled')).toBe('true');
    await expect(setPersonalSidebarView({ projects: { p: false } }, admission)).rejects.toThrow('admission retired');
    // Endpoint switching may mint URL auth via POST; neither personal PATCH nor shared PUT is allowed here.
    expect(f.writes.filter(write => write.method === 'PATCH' || write.method === 'PUT')).toEqual([]);
    await f.release(1);
    expect(f.view.bulkActionsReady).toBe(true);
  } finally { await f.close(); }
});
