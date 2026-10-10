import { expect, test } from 'bun:test';
import { act } from 'react';
import { initialReadFixture, settle, targetGroup, unrelatedGroup } from './useSessionProjectViewState.initial-read.fixture';

// Baseline has no readiness prop. Main can wire the producer's public header
// readiness prop in the fixture once integrated; these behavioral assertions stay.
test('actual Display mode Expand all clears the stored group when accepted around initial GET', async () => {
  const f = await initialReadFixture();
  try {
    await f.render();
    expect(f.reads).toHaveLength(1);
    expect(f.view.state.collapsedProjects.has('p')).toBe(true);
    expect(f.view.state.collapsedGroups.size).toBe(0);
    const item = await f.menuItem();
    const deferred = item.getAttribute('aria-disabled') === 'true';
    await act(async () => item.click()); await settle();
    expect(f.writes).toEqual([]); // GET remains held through the real menu attempt.
    await f.release();
    if (deferred) {
      const enabled = await f.menuItem();
      expect(enabled.getAttribute('aria-disabled')).not.toBe('true');
      await act(async () => enabled.click()); await settle();
    }
    console.info('initial-read accepted intent', JSON.stringify({
      deferred, patches: f.writes, collapsedProjects: [...f.view.state.collapsedProjects],
      collapsedGroups: [...f.view.state.collapsedGroups], persisted: f.persisted(),
    }));
    // This must fail on the original actual hook/menu, not on fixture loading.
    expect(f.persisted().groups[targetGroup]).toBe(false);
    expect(f.view.state.collapsedGroups.has(targetGroup)).toBe(false);
    expect(f.view.state.collapsedProjects.has('p')).toBe(false);
    expect(f.persisted().projects.p).toBe(false);
    expect(f.persisted().groups[unrelatedGroup]).toBe(true);
    expect(f.view.state.collapsedGroups.has(unrelatedGroup)).toBe(true);
    expect(f.writes.every(write => write.method === 'PATCH')).toBe(true);
  } finally { await f.close(); }
});

test('unhydrated real bulk menu does not change the view or dispatch PATCH', async () => {
  const f = await initialReadFixture();
  try {
    await f.render();
    const before = f.view.state;
    const expand = await f.menuItem();
    await act(async () => expand.click()); await settle();
    expect(f.writes).toEqual([]);
    expect(f.view.state.collapsedProjects).toEqual(before.collapsedProjects);
    expect(f.view.state.collapsedGroups).toEqual(before.collapsedGroups);
    expect(expand.getAttribute('aria-disabled')).toBe('true');
    const collapse = await f.menuItem('Collapse all');
    expect(collapse.getAttribute('aria-disabled')).toBe('true');
    await f.release();
    const enabled = await f.menuItem();
    expect(enabled.getAttribute('aria-disabled')).not.toBe('true');
    await act(async () => enabled.click()); await settle();
    expect(f.persisted().groups[targetGroup]).toBe(false);
    expect(f.view.state.collapsedGroups.has(targetGroup)).toBe(false);
  } finally { await f.close(); }
});

test('hydrated personal menu expands only displayed p and keeps unrelated q collapsed', async () => {
  const f = await initialReadFixture();
  try {
    await f.render(); await f.release();
    expect(f.view.state.collapsedGroups).toEqual(new Set([targetGroup, unrelatedGroup]));
    const expand = await f.menuItem();
    expect(expand.getAttribute('aria-disabled')).not.toBe('true');
    await act(async () => expand.click()); await settle();
    expect(f.view.state.collapsedProjects.has('p')).toBe(false);
    expect(f.view.state.collapsedGroups).toEqual(new Set([unrelatedGroup]));
    expect(f.persisted()).toEqual({ projects: { p: false }, groups: { [targetGroup]: false, [unrelatedGroup]: true } });
    expect(f.writes).toHaveLength(1);
    expect(JSON.parse(f.writes[0]!.body)).toEqual({
      owner: f.owner, projects: { p: false }, groups: { [targetGroup]: false },
    });
  } finally { await f.close(); }
});

test('failed initial owner admission leaves bulk controls guarded with no shared fallback', async () => {
  const f = await initialReadFixture();
  try {
    await f.render(); await f.release(0, 503);
    const before = f.view.state;
    const item = await f.menuItem();
    await act(async () => item.click()); await settle();
    expect(f.writes).toEqual([]);
    expect(f.view.state.collapsedProjects).toEqual(before.collapsedProjects);
    expect(item.getAttribute('aria-disabled')).toBe('true');
    expect(f.persisted().groups[targetGroup]).toBe(true);
  } finally { await f.close(); }
});

test('old GET cannot enable a new person while that persons own GET is pending', async () => {
  const f = await initialReadFixture();
  try {
    await f.render();
    await f.switchPerson();
    expect(f.reads).toHaveLength(2);
    await f.release(0);
    const before = f.view.state;
    const item = await f.menuItem();
    await act(async () => item.click()); await settle();
    expect(f.writes).toEqual([]);
    expect(f.view.state.collapsedProjects).toEqual(before.collapsedProjects);
    expect(item.getAttribute('aria-disabled')).toBe('true');
    expect(f.persisted('person-a').groups[targetGroup]).toBe(true);
    expect(f.persisted('person-b').groups[targetGroup]).toBe(true);
    await f.release(1);
    const enabled = await f.menuItem();
    expect(enabled.getAttribute('aria-disabled')).not.toBe('true');
    await act(async () => enabled.click()); await settle();
    expect(f.persisted('person-a').groups[targetGroup]).toBe(true);
    expect(f.persisted('person-b').groups[targetGroup]).toBe(false);
    expect(JSON.parse(f.writes.at(-1)!.body).owner.subject).toBe('person-b');
  } finally { await f.close(); }
});

test('hidden header still starts the owning hooks initial personal GET', async () => {
  const f = await initialReadFixture();
  try {
    await f.render(true);
    expect(f.reads).toHaveLength(1);
    expect(document.querySelector('[aria-label="Display mode"]')).toBeNull();
    expect(f.writes).toEqual([]);
    await f.release();
    expect(f.view.state.collapsedGroups.has(targetGroup)).toBe(true);
  } finally { await f.close(); }
});

test('legacy shared defaults keep actual bulk controls operational without a personal GET', async () => {
  const f = await initialReadFixture(false);
  try {
    await f.render();
    expect(f.reads).toEqual([]);
    const item = await f.menuItem();
    expect(item.getAttribute('aria-disabled')).not.toBe('true');
    await act(async () => item.click()); await settle();
    expect(f.view.state.collapsedProjects.has('p')).toBe(false);
    expect(f.view.state.collapsedGroups.has(targetGroup)).toBe(false);
    expect(f.writes.filter(write => write.method === 'PATCH')).toEqual([]);
  } finally { await f.close(); }
});
