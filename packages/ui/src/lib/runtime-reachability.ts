import { getRuntimeKey } from './runtime-switch';

// smarty-code#126 F9: under load a health probe can outlast its timeout while every other read succeeds. A successful
// answer from the current runtime proves the transport is up, so a slow probe alone must not declare the server gone.
// An explicit unhealthy (or malformed) health answer is different: the server answered and is not OK, and other reads
// never turn it into healthy (OC#197 review). Health probe responses are not transport evidence.
const RECENT_MS = 30_000;
let last: { runtimeKey: string; at: number } | null = null;
let unhealthy: string | null = null; // the runtime whose latest health answer was not healthy

/** Called for each successful (2xx) runtime response other than the health probe. */
export function noteRuntimeAnswered(): void { last = { runtimeKey: getRuntimeKey(), at: Date.now() }; }

/** The health probe's own verdict when the server answered it: healthy, or answered but not OK. */
export function noteRuntimeHealth(healthy: boolean): void { unhealthy = healthy ? null : getRuntimeKey(); }

/** True when the current runtime answered another read within 30 s and its health was not reported bad since. */
export function runtimeAnsweredRecently(now = Date.now()): boolean {
  const runtimeKey = getRuntimeKey();
  return unhealthy !== runtimeKey && last !== null && last.runtimeKey === runtimeKey && now - last.at <= RECENT_MS;
}
