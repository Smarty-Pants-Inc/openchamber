import { createHash } from 'crypto';
import path from 'path';
import { Hocuspocus } from '@hocuspocus/server';
import { WebSocketServer } from 'ws';

import { createDiskBridge } from './disk-bridge.js';

/** Co-editing rooms' WebSocket path: `?directory=<project>&path=<file>` names the one file a connection may edit. */
export const COEDIT_WS_PATH = '/api/coedit';
/** GET `?directory=&path=` → `{ name }`: the room's name (the file's canonical path), which the client's provider uses. */
export const COEDIT_ROOM_PATH = '/api/coedit/room';
/** A stateless message to the room's clients when a save could not be published (the editor shows it). */
export const CONFLICT_MESSAGE = 'coedit-conflict';

/**
 * Hocuspocus rooms for co-edited files (smartyfs#18, slice 1): one room per file, keyed by its canonical path.
 *
 * - An upgrade on COEDIT_WS_PATH passes the same checks as the app's other WebSockets (authenticated, allowed origin,
 *   and in human mode the signed-in person), then `admit(req, { directory, path })`: the Files view's project admission,
 *   which returns the canonical project root and file, or throws.
 * - A connection may open only the room it was admitted for; any other document name is refused (onAuthenticate).
 * - Each room is bridged to its file (disk-bridge.js): loaded from disk, outside writes merged in, saved (debounced) only
 *   over the revision last read; a conflict is broadcast to the room and kept for recovery.
 */
export function attachCoeditRooms({
  app, server, ensureAuthenticated, originAllowed, getUiAuthController, rejectWebSocketUpgrade, admit, recoveryRoot,
  createBridge = createDiskBridge, debounce = 2000,
}) {
  const bridges = new Map();
  const recoveryDirFor = (root) => path.join(recoveryRoot, createHash('sha256').update(root).digest('hex').slice(0, 16));
  const hocuspocus = new Hocuspocus({
    quiet: true,
    debounce,
    maxDebounce: debounce * 5,
    async onAuthenticate({ documentName, context }) {
      if (documentName !== context.room) throw new Error('This connection was not admitted to that file');
      return context;
    },
    async onLoadDocument({ document, documentName, context }) {
      const bridge = createBridge({
        root: context.root,
        file: context.file,
        doc: document,
        recoveryDir: recoveryDirFor(context.root),
        onConflict: (conflict) => document.broadcastStateless(JSON.stringify({
          type: CONFLICT_MESSAGE, conflict: conflict.conflict, at: conflict.at, recovered: Boolean(conflict.recovery),
        })),
      });
      await bridge.load();
      bridges.set(documentName, bridge);
      return document;
    },
    async onStoreDocument({ documentName }) {
      await bridges.get(documentName)?.save();
    },
    async afterUnloadDocument({ documentName }) {
      bridges.get(documentName)?.close();
      bridges.delete(documentName);
    },
  });

  const wsServer = new WebSocketServer({ noServer: true });
  const connect = (ws, req, room) => {
    const url = `http://${req.headers.host || '127.0.0.1'}${req.url || '/'}`;
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(name, String(value));
    const connection = hocuspocus.handleConnection(ws, new Request(url, { headers }), room);
    ws.on('message', (data) => connection.handleMessage(new Uint8Array(data)));
    ws.on('close', (code, reason) => connection.handleClose({ code, reason: String(reason) }));
  };

  const upgradeHandler = (req, socket, head) => {
    let url;
    try { url = new URL(req.url || '/', 'http://127.0.0.1'); } catch { return; }
    if (url.pathname !== COEDIT_WS_PATH) return;
    void (async () => {
      if (!await ensureAuthenticated(req, null).catch(() => false)) return rejectWebSocketUpgrade(socket, 401, 'Unauthorized');
      if (!await originAllowed(req).catch(() => false)) return rejectWebSocketUpgrade(socket, 403, 'Forbidden');
      let admitted;
      try {
        admitted = await admit(req, { directory: url.searchParams.get('directory'), path: url.searchParams.get('path') });
      } catch {
        return rejectWebSocketUpgrade(socket, 403, 'Forbidden');
      }
      const room = { room: admitted.file, root: admitted.root, file: admitted.file };
      const upgrade = () => wsServer.handleUpgrade(req, socket, head, (ws) => connect(ws, req, room));
      const controller = getUiAuthController?.() ?? null;
      if (controller?.humanMode) await controller.requireUpgradeAuth(req, socket, upgrade, rejectWebSocketUpgrade);
      else upgrade();
    })().catch(() => rejectWebSocketUpgrade(socket, 403, 'Forbidden'));
  };

  // The client knows the Files view's path, not the canonical one (a project reached through a link): the room is
  // named here, with the same checks as the upgrade, so every client of one file joins one room.
  app?.get(COEDIT_ROOM_PATH, async (req, res) => {
    if (!await ensureAuthenticated(req, res).catch(() => false)) {
      if (!res.headersSent) res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (!await originAllowed(req).catch(() => false)) return res.status(403).json({ error: 'Forbidden' });
    try {
      const admitted = await admit(req, { directory: String(req.query.directory ?? ''), path: String(req.query.path ?? '') });
      res.json({ name: admitted.file });
    } catch {
      res.status(403).json({ error: 'Forbidden' });
    }
  });

  server.on('upgrade', upgradeHandler);
  return {
    hocuspocus,
    async stop() {
      server.off('upgrade', upgradeHandler);
      await hocuspocus.flushPendingStores?.();
      for (const bridge of bridges.values()) bridge.close();
      wsServer.close();
    },
  };
}
