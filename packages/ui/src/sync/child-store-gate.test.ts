import { expect, test } from 'bun:test';
import { ChildStoreManager } from './child-store';

// #126 startup 403s: bootstraps wait while managed discovery is pending, then non-admitted directories are dropped.
test('the bootstrap gate holds the queue, then parks denied directories and runs admitted ones', async () => {
  const manager = new ChildStoreManager();
  const started: string[] = [];
  let verdict: (directory: string) => 'allow' | 'wait' | 'deny' = () => 'wait';
  manager.setBootstrapGate((directory) => verdict(directory));
  const cleanup = manager.configure({ bootstrapConcurrency: 6, onBootstrap: async ({ directory }) => { started.push(directory); } });
  manager.requestBootstrap({ directory: '/home/user', priority: 'selected', reason: 'current-directory' });
  manager.requestBootstrap({ directory: '/repo/admitted', priority: 'expanded', reason: 'project-expanded' });
  await Promise.resolve();
  expect(started).toEqual([]);
  verdict = (directory) => directory === '/repo/admitted' ? 'allow' : 'deny';
  manager.setBootstrapGate((directory) => verdict(directory));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(started).toEqual(['/repo/admitted']);
  // A parked directory starts once the gate admits it (a catalog refresh that lists a new worktree).
  verdict = () => 'allow';
  manager.setBootstrapGate((directory) => verdict(directory));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(started).toEqual(['/repo/admitted', '/home/user']);
  cleanup();
  manager.disposeAll();
});
