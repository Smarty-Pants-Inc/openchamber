// Preload for isolated native-draft/composer tests. Per-test synthetic handlers
// restore this guard, never the real transport, so late work cannot reach DNS.
// Run with: bun test --preload ./src/sync/native-test-network.ts <test-file>
globalThis.fetch = async () => {
  throw new Error('Native fixture network denied outside an active synthetic handler');
};
