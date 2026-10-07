const sameMember = (left, right) => left === null && right === null || Boolean(left && right
  && left.nodeId === right.nodeId && left.orgId === right.orgId
  && left.smartyId === right.smartyId && left.googleSubject === right.googleSubject);

/** Owns admitted HTTP responses and raw upgrade sockets, never native session lifetime. */
export function createHumanConnectionLifetime({ resolve, members, adapter, admits }) {
  const sessions = new Map();
  let watcher = null, sweeping = false, disposed = false;
  const stopWatcher = () => { clearInterval(watcher); watcher = null; };
  const closeSession = id => {
    for (const entry of [...(sessions.get(id) || [])]) entry.close();
  };
  const sweep = async () => {
    if (sweeping || disposed) return;
    sweeping = true;
    try {
      // One lookup per person per sweep, regardless of their open tabs/streams.
      const currentMembers = new Map();
      for (const entries of [...sessions.values()]) {
        for (const entry of [...entries]) {
          if (members.required && !currentMembers.has(entry.userId)) {
            currentMembers.set(entry.userId, members.lookup(adapter, entry.userId).catch(() => null));
          }
          // smarty-code#1391: a person removed from the members list loses open streams too, not only new requests.
          if (admits?.revocable && !admits(entry.user)) { entry.close(); continue; }
          if (members.required && !sameMember(entry.member, await currentMembers.get(entry.userId))) entry.close();
        }
      }
    } finally { sweeping = false; }
  };
  const admit = async (req, res, session) => {
    if (disposed) { res.destroy(); return null; }
    if (res.destroyed || res.writableEnded) return null;
    const id = session.session.id, userId = session.user.id;
    const admittedMember = members.forwardedMember(session);
    const member = admittedMember ? Object.freeze(admittedMember) : null;
    const entries = sessions.get(id) || new Set();
    sessions.set(id, entries);
    let closed = false, timer;
    const cleanup = () => {
      if (closed) return;
      closed = true; clearTimeout(timer); entries.delete(entry);
      res.off('close', cleanup); res.off('finish', cleanup);
      if (!entries.size) sessions.delete(id);
      if (!sessions.size) stopWatcher();
    };
    const close = () => { cleanup(); res.destroy(); };
    const isOpen = () => !closed && !disposed && !res.destroyed && !res.writableEnded;
    const recheck = async () => {
      if (!isOpen()) { cleanup(); return null; }
      const current = await resolve(req);
      if (!isOpen() || !current || current.session.id !== id || current.user.id !== userId
        || !sameMember(member, members.forwardedMember(current))) {
        close(); return null;
      }
      return current;
    };
    const entry = { member, userId, user: { email: session.user.email, emailVerified: session.user.emailVerified }, close };
    let admitted = false;
    try {
      entries.add(entry);
      res.once('close', cleanup); res.once('finish', cleanup);
      const remaining = new Date(session.session.expiresAt).getTime() - Date.now();
      if (remaining <= 0) { closeSession(id); return null; }
      timer = setTimeout(close, Math.min(remaining, 2_147_483_647)); timer.unref?.();
      if ((members.required || admits?.revocable) && !watcher) { watcher = setInterval(() => { void sweep(); }, 1000); watcher.unref?.(); }
      // Register before rechecking: deletion or a membership change cannot leave an untracked stream.
      const current = await recheck();
      if (!current) return null;
      req.humanConnection = Object.freeze({ authorize: async () => Boolean(await recheck()) });
      admitted = true;
      return current;
    } finally { if (!admitted) close(); }
  };
  return { admit, closeSession, dispose: () => {
    disposed = true; stopWatcher();
    for (const id of [...sessions.keys()]) closeSession(id);
  } };
}
