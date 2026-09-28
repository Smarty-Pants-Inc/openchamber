// smarty-net#136 L3: the Node registry token is for this server's billing lookup only. It is taken and removed from the
// environment when this module loads: index.js imports it (through bootstrap-runtime.js) before its body takes the
// login-shell snapshot, starts the managed engine or any terminal (ES modules finish loading before the body runs).
// Under Bun the native environ must be cleared too: bun-pty merges it even after a JavaScript delete (inherited-env.js).
// If that native removal fails, startup fails: a terminal could otherwise inherit the token. Bun.spawn with no env
// keeps Bun's own start-up copy, so this server never calls it (registry-token.test.js). Nothing here logs the value.
import { createRequire } from 'node:module';

const KEY = 'NODE_REGISTRY_TOKEN';

/** Bun's native unsetenv, or null outside Bun (Node's `delete process.env.X` already unsets the real environment). */
function nativeUnsetenv() {
  if (!process.versions.bun || process.platform === 'win32') return null;
  const { dlopen } = createRequire(import.meta.url)('bun:ffi');
  const libc = dlopen(process.platform === 'darwin' ? 'libc.dylib' : 'libc.so.6', { unsetenv: { args: ['cstring'], returns: 'i32' } });
  return (name) => libc.symbols.unsetenv(Buffer.from(`${name}\0`));
}

/** Takes the token out of `env`; throws (fail closed) when a native removal is needed and does not succeed. */
export function takeRegistryToken(env, loadUnsetenv = nativeUnsetenv) {
  const token = env[KEY] || '';
  delete env[KEY];
  if (!token) return '';
  let unset;
  try { unset = loadUnsetenv(); } catch { unset = undefined; }
  if (unset === null) return token;
  if (!unset || unset(KEY) !== 0) throw new Error(`${KEY} could not be removed from the native environment; not starting`);
  return token;
}

const token = takeRegistryToken(process.env);
/** The token this process was started with (empty when none). */
export const registryToken = () => token;
