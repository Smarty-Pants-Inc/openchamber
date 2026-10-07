/**
 * Node members are read-only on shared agents until member execution is isolated (smarty-code#1442): a prompt is a
 * way to have the shared agent run commands as the server account. A member may view sessions, but every request that
 * prompts, commands, aborts, approves a tool run or queues work for the agent is refused before it reaches the agent
 * (the OpenCode proxy or OpenChamber's own agent routes). Members are the admitted humans the auth gate marks
 * (`req.humanIdentity.member`, set only in Node mode); owners and other modes are unchanged.
 */
export const MEMBER_AGENT_READ_ONLY = 'members can view this agent; prompting needs isolation, #1442';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Relative to /api. OpenCode: session actions, permission and question replies, the TUI bridge. OpenChamber: the
// message queue, goals, control, Pi session send and fork, permission auto-accept, scheduled tasks.
const AGENT_ACTION = new RegExp('^/(?:session|permission|question|tui|message-queue|goals|permission-auto-accept)(?:/|$)'
  + '|^/openchamber/(?:control|sessions)(?:/|$)|^/projects/[^/]+/scheduled-tasks(?:/|$)');

/** The path the upstream router would see: decoded, backslashes as slashes, dot segments resolved, repeated slashes
 *  collapsed, lower case. Undecodable input is treated as an agent action. */
const routedPath = (path) => {
  try {
    // Collapse before parsing too: a leading `//` would otherwise parse as a host.
    const flat = decodeURIComponent(path).replace(/\\/g, '/').replace(/\/{2,}/g, '/');
    const pathname = new URL(flat, 'http://route.invalid').pathname;
    return pathname.replace(/\/{2,}/g, '/').toLowerCase();
  } catch {
    return null;
  }
};

export const refuseMemberAgentActions = (req, res, next) => {
  if (!req.humanIdentity?.member || SAFE_METHODS.has(req.method)) return next();
  const path = routedPath(req.path);
  if (path !== null && !AGENT_ACTION.test(path)) return next();
  return res.status(403).json({ error: MEMBER_AGENT_READ_ONLY, code: 'NODE_MEMBER_AGENT_READ_ONLY' });
};
