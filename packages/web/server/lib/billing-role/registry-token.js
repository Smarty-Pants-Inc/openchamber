// smarty-net#136 L3: the Node registry token is for this server's billing lookup only. It is taken and removed from the
// environment when this module loads: index.js imports it (through bootstrap-runtime.js) before its body takes the
// login-shell snapshot, starts the managed engine or any terminal (ES modules finish loading before the body runs).
// Under Bun the native environ is cleared too: bun-pty merges it even after a JavaScript delete (inherited-env.js).
// Bun.spawn with no env keeps Bun's own start-up copy, so this server never calls it (registry-token.test.js).
// Nothing here logs the value.
import { createRequire } from 'node:module';

const KEY = 'NODE_REGISTRY_TOKEN';
const token = process.env[KEY] || '';
delete process.env[KEY];
if (process.versions.bun && process.platform !== 'win32') {
  try {
    const { dlopen } = createRequire(import.meta.url)('bun:ffi');
    const libc = dlopen(process.platform === 'darwin' ? 'libc.dylib' : 'libc.so.6', { unsetenv: { args: ['cstring'], returns: 'i32' } });
    libc.symbols.unsetenv(Buffer.from(`${KEY}\0`));
  } catch { /* no bun:ffi: children then get the explicit environments this server builds */ }
}

/** The token this process was started with (empty when none). */
export const registryToken = () => token;
