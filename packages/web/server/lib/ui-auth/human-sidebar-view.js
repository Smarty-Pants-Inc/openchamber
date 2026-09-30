import { z } from 'zod';

const path = '/api/config/sidebar-view';
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const keySchema = z.string().min(1).max(8192).regex(/^[^\u0000-\u001f\u007f]+$/u)
  .refine(key => !['__proto__', 'constructor', 'prototype'].includes(key));
// Zod records skip __proto__; reject it before parsing rather than silently dropping an entry.
const mapSchema = z.preprocess(value => value != null && Object.keys(value).includes('__proto__') ? null : value,
  z.record(keySchema, z.boolean()).refine(map => Object.keys(map).length <= 2048));
const storedSchema = z.object({ projects: mapSchema, groups: mapSchema }).strict();
const patchSchema = z.object({
  owner: z.object({ issuer: z.string().min(1).max(2048), subject: z.string().min(1).max(128) }).strict(),
  projects: mapSchema.optional(), groups: mapSchema.optional(),
}).strict();

function parsePatch(body) {
  const serialized = JSON.stringify(body);
  if (serialized && Buffer.byteLength(serialized) > 65536) fail(413, 'Sidebar preference patch exceeds request limit');
  const result = patchSchema.safeParse(body);
  if (!result.success) fail(400, 'Invalid sidebar preference patch');
  return { owner: result.data.owner, projects: result.data.projects ?? {}, groups: result.data.groups ?? {} };
}

function parseStored(value) {
  if (value === null || value === undefined) return { projects: {}, groups: {} };
  try {
    const serialized = z.string().parse(value);
    if (Buffer.byteLength(serialized) > 262144) throw new Error('Invalid size');
    return storedSchema.parse(JSON.parse(serialized));
  } catch { fail(500, 'Stored sidebar preferences are invalid'); }
}

/** One running auth controller owns the ordering queue; the Better Auth user row owns durability. */
export function createHumanSidebarView({ auth, resolve, actor }) {
  const pending = new Map();
  return async (req, res) => {
    const requireOpenResponse = () => {
      if (res?.destroyed || res?.writableEnded) fail(401, 'Human authentication required');
    };
    const admitted = req.humanIdentity;
    if (!admitted) fail(401, 'Human authentication required');
    const patch = req.method === 'PATCH' ? parsePatch(req.body) : null;
    const owner = { issuer: admitted.issuer, subject: admitted.subject };
    if (patch && (patch.owner.issuer !== owner.issuer || patch.owner.subject !== owner.subject)) {
      fail(409, 'Sidebar preference owner changed');
    }
    const previous = pending.get(owner.subject) || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      // A queued request cannot borrow another person or a revoked session's authority.
      requireOpenResponse();
      const session = await resolve(req);
      if (!session) fail(401, 'Human authentication required');
      const current = actor(session);
      if (current.issuer !== owner.issuer || current.subject !== owner.subject) fail(409, 'Sidebar preference owner changed');
      const { adapter } = await auth.$context;
      const where = [{ field: 'id', value: current.subject }];
      const user = await adapter.findOne({ model: 'user', where });
      if (!user) fail(401, 'Human authentication required');
      // The user lookup may outlive revocation or expiry of the protected response.
      requireOpenResponse();
      const authoritative = await adapter.findOne({ model: 'session',
        where: [{ field: 'id', value: session.session.id }], select: ['userId', 'expiresAt'] });
      requireOpenResponse();
      if (!authoritative || new Date(authoritative.expiresAt).getTime() <= Date.now()) {
        fail(401, 'Human authentication required');
      }
      if (authoritative.userId !== owner.subject) fail(409, 'Sidebar preference owner changed');
      const stored = parseStored(user.sidebarPreferences);
      if (!patch) return { owner, ...stored };
      const merged = { projects: { ...stored.projects, ...patch.projects }, groups: { ...stored.groups, ...patch.groups } };
      // Reject capacity overflow atomically, never discard older keys.
      if (!storedSchema.safeParse(merged).success) fail(400, 'Sidebar preferences exceed entry limit');
      const serialized = JSON.stringify(merged);
      if (Buffer.byteLength(serialized) > 262144) fail(413, 'Sidebar preferences exceed storage limit');
      requireOpenResponse();
      const updated = await adapter.update({ model: 'user', where, update: { sidebarPreferences: serialized } });
      if (!updated) fail(500, 'Sidebar preferences could not be saved');
      return { owner, ...merged };
    });
    pending.set(owner.subject, operation);
    try { return await operation; }
    finally { if (pending.get(owner.subject) === operation) pending.delete(owner.subject); }
  };
}

/** Called after API authentication and before the generic proxy. Legacy mode is explicitly unsupported. */
export function registerHumanSidebarViewRoutes(app, { express, humanAuth }) {
  const handle = async (req, res) => {
    if (!humanAuth) return res.status(501).json({ error: 'Personal sidebar preferences require human authentication' });
    try {
      const view = await humanAuth.sidebarView(req, res);
      if (res.destroyed || res.writableEnded) return;
      return res.json(view);
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      const status = [400, 401, 409, 413].includes(error.status) ? error.status : 500;
      return res.status(status).json({ error: status === 500 ? 'Sidebar preferences are unavailable' : error.message });
    }
  };
  app.get(path, handle);
  app.patch(path, express.json({ limit: '64kb' }), handle, (error, _req, res, _next) => {
    const status = error.status === 413 ? 413 : 400;
    res.status(status).json({ error: 'Invalid sidebar preference request body' });
  });
}
