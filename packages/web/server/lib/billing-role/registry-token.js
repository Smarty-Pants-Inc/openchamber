// smarty-net#136 L3: the Node registry token is for this server's billing lookup only. It is taken and removed from the
// environment when this module loads: index.js imports it (through bootstrap-runtime.js) before its body takes the
// login-shell snapshot, starts the managed engine or any terminal (ES modules finish loading before the body runs).
// Under Node, `delete process.env.X` unsets the real environment, so no child inherits it. Under Bun it cannot be
// removed: Bun gives child_process and Bun.spawn calls without an explicit env its own start-up copy of the environment
// (Bun 1.3.14; 1.4.0 only for Bun.spawn), which no delete or unsetenv reaches. So with a token, a Bun server does not
// start (fail closed); Smarty Code runs this server under Node. Nothing here logs the value.
const KEY = 'NODE_REGISTRY_TOKEN';

/** Takes the token out of `env`; throws (fail closed) under Bun when a token was given. */
export function takeRegistryToken(env, bun = Boolean(process.versions.bun)) {
  const token = env[KEY] || '';
  delete env[KEY];
  if (token && bun) throw new Error(`${KEY} cannot be kept from child processes under Bun; run this server under Node`);
  return token;
}

const token = takeRegistryToken(process.env);
/** The token this process was started with (empty when none). */
export const registryToken = () => token;
