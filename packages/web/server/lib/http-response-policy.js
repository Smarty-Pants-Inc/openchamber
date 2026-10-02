import { validateHeaderName, validateHeaderValue } from 'node:http';
import { z } from 'zod';
import { validatedPolicyHeaderValue } from './http-policy-header-values.js';

const DEADLINE_MS = 5000;
const policyCacheControl = new WeakMap();
const headerPairs = z.array(z.tuple([z.string(), z.string()])).max(64);
const sessionDate = z.union([z.date(), z.string().min(1), z.number().finite()]).pipe(z.coerce.date());
const sessionMetadata = z.object({ session: z.object({
  id: z.string().min(1).max(128), createdAt: sessionDate, expiresAt: sessionDate,
}) });

/** Only a validated, completed server policy can override a route's stock cache decision. */
export const responsePolicyCacheControl = (response, fallback) => policyCacheControl.get(response) ?? fallback;

/** Keep separate CSPs independent. With no earlier policy, preserve the stock single-value header. */
export const appendContentSecurityPolicy = (response, value) => {
  const previous = response.getHeader?.('Content-Security-Policy');
  response.setHeader('Content-Security-Policy', previous === undefined
    ? value : [...(Array.isArray(previous) ? previous : [previous]), value]);
};

const sanitizeSession = (resolved) => {
  if (resolved === null) return null;
  const parsed = sessionMetadata.safeParse(resolved);
  if (!parsed.success) throw new Error('Invalid authenticated session metadata');
  const { id, createdAt, expiresAt } = parsed.data.session;
  if (expiresAt.getTime() <= Date.now()) return null;
  return Object.freeze({ id, createdAt: createdAt.getTime(), expiresAt: expiresAt.getTime() });
};

const validateHeaders = (result) => {
  const parsed = headerPairs.safeParse(result);
  if (!parsed.success) throw new Error('Invalid response policy headers');
  let bytes = 0;
  const headers = parsed.data.map(([name, value]) => {
    validateHeaderName(name); validateHeaderValue(name, value);
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value);
    const normalized = name.toLowerCase();
    return Object.freeze([normalized, validatedPolicyHeaderValue(normalized, value)]);
  });
  if (bytes > 16 * 1024) throw new Error('Response policy headers are too large');
  return Object.freeze(headers);
};

/** Optional HTTP-only policy. No response writer or middleware continuation is exposed to the callback. */
export function createResponsePolicyMiddleware(responsePolicy, humanAuth) {
  if (responsePolicy === undefined) return null;
  if (!(responsePolicy instanceof Function)) throw new TypeError('responsePolicy must be a function');
  return async (request, response, next) => {
    const controller = new AbortController();
    const cancelled = Symbol('cancelled');
    const started = performance.now();
    let cancel, lookup, authFailed = false, active = true;
    const aborted = new Promise(resolve => { cancel = resolve; });
    const abort = () => { controller.abort(); cancel(cancelled); };
    const closed = () => response.destroyed || response.writableEnded;
    const withinDeadline = () => !controller.signal.aborted && performance.now() - started < DEADLINE_MS;
    const unavailable = () => new Error('Response policy unavailable');
    response.once('close', abort);
    const timer = setTimeout(abort, DEADLINE_MS);
    timer.unref?.();
    const getHumanSession = () => {
      if (!active || closed() || !withinDeadline()) return Promise.reject(unavailable());
      if (!lookup) {
        lookup = Promise.race([
          Promise.resolve().then(() => humanAuth ? humanAuth.resolve(request) : null).then(sanitizeSession), aborted,
        ]).then(value => {
          if (value === cancelled || !withinDeadline() || closed()) throw unavailable();
          return value;
        }).catch(error => { authFailed = true; throw error; });
        // Track even an unawaited lookup, then fail closed below. It must not leak an unhandled rejection.
        void lookup.catch(() => {});
      }
      return lookup;
    };
    try {
      if (closed() || !withinDeadline()) throw unavailable();
      const context = Object.freeze({ signal: controller.signal, getHumanSession });
      const result = await Promise.race([
        Promise.resolve().then(() => {
          if (closed() || !withinDeadline()) throw unavailable();
          return responsePolicy(request, context);
        }), aborted,
      ]);
      if (result === cancelled) throw unavailable();
      if (lookup) await lookup;
      if (authFailed) throw unavailable();
      const headers = validateHeaders(result);
      if (closed() || !withinDeadline()) throw unavailable();
      for (const [name, value] of headers) {
        if (name === 'content-security-policy') appendContentSecurityPolicy(response, value);
        else if (name === 'vary') response.vary(value);
        else {
          if (name === 'cache-control') policyCacheControl.set(response, value);
          response.setHeader(name, value);
        }
      }
      return next();
    } catch {
      if (!closed() && !response.headersSent) {
        response.setHeader('Cache-Control', 'private, no-store');
        response.status(503).json({ error: 'Response policy unavailable' });
      }
    } finally {
      active = false;
      clearTimeout(timer);
    }
  };
}
