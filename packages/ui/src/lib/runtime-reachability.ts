import { getRuntimeKey } from './runtime-switch';

// smarty-code#126 F9: under load a health probe can outlast its timeout while every other read succeeds. A successful
// answer from the current runtime proves the transport is up, so a slow probe alone must not declare the server gone.
// An explicit unhealthy (or malformed) health answer is different: the server answered and is not OK, and other reads
// never turn it into healthy (OC#197 review). Health probe responses are not transport evidence. Each runtime keeps
// its own records: another runtime's answers never speak for it (A -> B -> A).
const RECENT_MS = 30_000;
const answeredAt = new Map<string, number>();
const unhealthy = new Set<string>(); // runtimes whose latest health answer was not healthy

/** Called for each successful (2xx) runtime response other than the health probe. */
export function noteRuntimeAnswered(runtimeKey = getRuntimeKey()): void { answeredAt.set(runtimeKey, Date.now()); }

/** The health probe's own verdict when the server answered it: healthy, or answered but not OK. */
export function noteRuntimeHealth(healthy: boolean, runtimeKey = getRuntimeKey()): void {
  if (healthy) unhealthy.delete(runtimeKey); else unhealthy.add(runtimeKey);
}

/** True when the current runtime answered another read within 30 s and its own health was not reported bad since. */
export function runtimeAnsweredRecently(now = Date.now()): boolean {
  const runtimeKey = getRuntimeKey(), at = answeredAt.get(runtimeKey);
  return !unhealthy.has(runtimeKey) && at !== undefined && now - at <= RECENT_MS;
}
