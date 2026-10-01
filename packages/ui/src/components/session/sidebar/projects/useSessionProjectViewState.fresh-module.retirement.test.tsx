import { expect, test } from 'bun:test';
import { act } from 'react';
import { freshModuleFixture, settle, targetGroup } from './useSessionProjectViewState.fresh-module.fixture';

class UnreadableSet extends Set<string> {
  override [Symbol.iterator](): SetIterator<string> { throw new Error('Blocked bulk enumerated'); }
  override has(): boolean { throw new Error('Blocked bulk inspected'); }
}

test('pending/stale bulk cannot queue intent; retired queued initiator cannot borrow successor owner', async () => {
  const f = await freshModuleFixture();
  try {
    await f.render();
    const stale = f.view.actions;
    let updates = 0;
    const blocked = () => {
      stale.collapseAllProjects(); stale.expandAllProjects();
      stale.setCollapsedProjects(previous => { updates++; return previous; });
      stale.setCollapsedGroups(previous => { updates++; return previous; });
      stale.setCollapsedProjects(new UnreadableSet());
      stale.setCollapsedGroups(new UnreadableSet());
      stale.scheduleCollapsedProjectsPersist(new UnreadableSet());
    };
    await act(async () => blocked()); await settle();
    expect(updates).toBe(0);
    expect(f.mutations).toEqual([]);
    expect(f.writes).toEqual([]);
    const admission = f.personal.capturePersonalSidebarAdmission();
    const patch = { groups: { [targetGroup]: true } };
    // Copy synchronously, then retire while the initiating owner GET is held.
    let queued = Promise.resolve('not initiated');
    await act(async () => {
      queued = f.personal.setPersonalSidebarView(patch, admission).then(
        () => 'unexpected success', error => error.message,
      );
    });
    patch.groups[targetGroup] = false;
    await settle();
    expect(f.mutations).toEqual([{ groups: { [targetGroup]: true } }]);
    expect(f.view.state.collapsedGroups.has(targetGroup)).toBe(true);
    expect(f.writes).toEqual([]);
    await f.switchPerson();
    expect(f.reads).toHaveLength(2);
    expect(f.view.bulkActionsReady).toBe(false);
    await act(async () => blocked()); await settle();
    expect(updates).toBe(0);
    const poisoned = { get projects(): Record<string, boolean> { throw new Error('Retired payload inspected'); } };
    await expect(f.personal.setPersonalSidebarView(poisoned, admission)).rejects.toThrow('admission retired');
    await f.release(0);
    expect(await queued).toBe('Runtime request is stale');
    expect(f.view.bulkActionsReady).toBe(false);
    expect(f.writes).toEqual([]);
    await f.release(1);
    expect(f.view.bulkActionsReady).toBe(true);
    expect(f.view.state.collapsedGroups.has(targetGroup)).toBe(false);
    expect(f.mutations).toHaveLength(1);
    expect(f.writes).toEqual([]);
    expect(f.persisted('person-a')).toEqual({ projects: {}, groups: { unrelated: true } });
    expect(f.persisted('person-b')).toEqual({ projects: {}, groups: { unrelated: true } });
    await expect(f.personal.setPersonalSidebarView({ groups: { [targetGroup]: true } }, admission)).rejects.toThrow('admission retired');
    await f.click('group');
    expect(f.writes).toHaveLength(1);
    expect(JSON.parse(f.writes[0]!.body)).toEqual({ owner: f.owner, groups: { [targetGroup]: true } });
    expect(f.writes[0]!.subject).toBe('person-b');
    expect(f.persisted('person-a').groups[targetGroup]).toBeUndefined();
    expect(f.persisted('person-b').groups[targetGroup]).toBe(true);
    expect(f.failures).toBe(0);
  } finally { await f.close(); }
});
