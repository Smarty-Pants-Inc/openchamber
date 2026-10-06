import { parseRequestPathname } from '../terminal/terminal-ws-protocol.js';

/**
 * Refuses a WebSocket upgrade that no endpoint serves.
 *
 * Node hands every upgrade to the 'upgrade' listeners and does nothing else, so
 * a path none of them claims (for example a removed endpoint such as
 * /api/dev-tunnel) would otherwise hold the socket open with no answer. The
 * served set is composed from the owning runtimes' own path constants.
 */
export const attachUnclaimedUpgradeRefusal = ({ server, servedPaths, servedPatterns = [], rejectWebSocketUpgrade }) => {
  const served = new Set(servedPaths);
  const upgradeHandler = (req, socket) => {
    const pathname = parseRequestPathname(req.url);
    if (served.has(pathname) || servedPatterns.some((pattern) => pattern.test(pathname))) return;
    rejectWebSocketUpgrade(socket, 404, 'Not found');
  };
  server.on('upgrade', upgradeHandler);
  return {
    stop: () => server.off('upgrade', upgradeHandler),
  };
};
