import { test } from 'bun:test';
import { manualFirstMount } from './useSessionProjectViewState.fresh-module.assertions';

// The isolated repository runner gives this case its own module singleton.
test('fresh pre-auth module: first manual group click survives held owner GET', async () => {
  await manualFirstMount('group');
});
