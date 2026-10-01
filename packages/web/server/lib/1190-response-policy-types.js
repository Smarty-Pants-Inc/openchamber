// Compile-only consumer. Do not execute: importing the public server initializes its runtime.
// @ts-check
import { HTTP_RESPONSE_POLICY_VERSION } from '../index.js';

/** @type {1} */
const capability = HTTP_RESPONSE_POLICY_VERSION;
/** @type {import('../index.js').StartWebUiServerOptions} */
const options = {
  responsePolicy: async (request, context) => {
    /** @type {import('node:http').IncomingMessage} */
    const incoming = request;
    /** @type {AbortSignal} */
    const signal = context.signal;
    const session = await context.getHumanSession();
    if (session) {
      /** @type {number} */
      const createdAt = session.createdAt;
      /** @type {number} */
      const expiresAt = session.expiresAt;
      /** @type {string} */
      const id = session.id;
      // @ts-expect-error The public session intentionally exposes no credential.
      void session.token;
      // @ts-expect-error The public session intentionally exposes no profile or actor.
      void session.email;
      void createdAt; void expiresAt; void id;
    }
    void incoming; void signal;
    /** @type {readonly (readonly [string, string])[]} */
    const headers = [['Cache-Control', 'private, no-store']];
    return headers;
  },
};
void capability; void options;
