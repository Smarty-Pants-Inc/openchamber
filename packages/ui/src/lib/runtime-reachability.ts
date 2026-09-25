import { getRuntimeKey } from './runtime-switch';

// smarty-code#126 F9: under load a health probe can outlast its timeout while every other read succeeds. A successful
// answer from the current runtime proves it is reachable, so a slow probe alone must not declare the server gone.
const RECENT_MS = 30_000;
let last: { runtimeKey: string; at: number } | null = null;

/** Called for each successful (2xx) runtime response. */
export function noteRuntimeAnswered(): void { last = { runtimeKey: getRuntimeKey(), at: Date.now() }; }

/** True when the current runtime answered a request successfully within the last 30 s. */
export function runtimeAnsweredRecently(now = Date.now()): boolean {
  return last !== null && last.runtimeKey === getRuntimeKey() && now - last.at <= RECENT_MS;
}
