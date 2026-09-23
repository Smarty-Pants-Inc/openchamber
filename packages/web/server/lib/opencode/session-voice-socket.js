import { WebSocket, WebSocketServer } from 'ws';

// Smarty Code session voice: one browser WebSocket per call, proxied to the Code gateway's
// session voice socket. The gateway owns the call; this edge only authenticates and pipes.
const VOICE_SOCKET_PATH = /^\/api\/session\/([^/]+)\/voice\/socket$/;
const MAX_FRAME_BYTES = 64 * 1024;
// About two seconds of PCM16 24 kHz audio; a slower page drops audio instead of buffering.
const MAX_AUDIO_BACKLOG_BYTES = 24_000 * 2 * 2;

const refusalMessage = async (response) => {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response) {
    bytes += chunk.length;
    if (bytes > 16 * 1024) break;
    chunks.push(chunk);
  }
  try {
    const message = String(JSON.parse(Buffer.concat(chunks).toString('utf8'))?.data?.message ?? '');
    if (message) return message.slice(0, 200);
  } catch {
    // Fixed text below.
  }
  return 'The voice call was refused';
};

/** Pipes frames both ways; browser frames sent before the gateway opens wait (bounded). */
const pipe = (browser, upstream) => {
  const early = [];
  let earlyBytes = 0;
  browser.on('message', (data, isBinary) => {
    if (upstream.readyState === WebSocket.CONNECTING) {
      earlyBytes += data.length;
      if (earlyBytes <= MAX_AUDIO_BACKLOG_BYTES) early.push([data, isBinary]);
      return;
    }
    if (upstream.readyState !== WebSocket.OPEN) return;
    if (isBinary && upstream.bufferedAmount > MAX_AUDIO_BACKLOG_BYTES) return;
    upstream.send(data, { binary: isBinary });
  });
  upstream.once('open', () => { for (const [data, isBinary] of early.splice(0)) upstream.send(data, { binary: isBinary }); });
  upstream.on('message', (data, isBinary) => {
    if (browser.readyState !== WebSocket.OPEN) return;
    if (isBinary && browser.bufferedAmount > MAX_AUDIO_BACKLOG_BYTES) return;
    browser.send(data, { binary: isBinary });
  });
  const end = (reason) => {
    if (browser.readyState === WebSocket.OPEN && reason) browser.send(JSON.stringify({ type: 'ended', reason }));
    for (const socket of [browser, upstream]) {
      if (socket.readyState === WebSocket.OPEN) socket.close(1000, 'Voice call ended');
      else if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
    }
  };
  // Refusals reach the page as a reason it can show; a WebSocket page cannot read HTTP bodies.
  upstream.once('unexpected-response', (_request, response) => {
    void refusalMessage(response).then(end, () => end('The voice call was refused'));
  });
  upstream.on('error', () => end('Voice is unavailable'));
  browser.on('close', () => end());
  upstream.on('close', () => end());
  browser.on('error', () => browser.terminate());
};

/**
 * Only signed-in humans (Smarty human auth) may open a voice call. The exact Origin and the
 * session check come from requireUpgradeAuth, which also closes the socket on sign-out. The
 * gateway receives the server bearer and the human actor, never browser cookies or Origin.
 */
export const attachSessionVoiceSocket = ({
  server, getUiAuthController, rejectWebSocketUpgrade, buildOpenCodeUrl, getOpenCodeAuthHeaders,
}) => {
  const browsers = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

  const connect = (req, socket, head, sessionId, directory) => {
    const authorization = getOpenCodeAuthHeaders()?.Authorization;
    let target;
    try {
      target = new URL(buildOpenCodeUrl(`/session/${encodeURIComponent(sessionId)}/voice/socket`));
    } catch {
      target = undefined;
    }
    if (!authorization || !req.humanIdentity || !target) {
      rejectWebSocketUpgrade(socket, 503, 'Voice needs an authenticated gateway');
      return;
    }
    target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
    target.searchParams.set('directory', directory);
    const identity = Buffer.from(JSON.stringify(req.humanIdentity)).toString('base64url');
    browsers.handleUpgrade(req, socket, head, (browser) => pipe(browser, new WebSocket(target, {
      maxPayload: MAX_FRAME_BYTES,
      headers: { Authorization: authorization, 'x-smarty-human-identity': identity },
    })));
  };

  const upgradeHandler = (req, socket, head) => {
    let url;
    try { url = new URL(req.url || '/', 'http://127.0.0.1'); } catch { return; }
    const match = VOICE_SOCKET_PATH.exec(url.pathname);
    if (!match) return;
    const directory = url.searchParams.get('directory');
    const controller = getUiAuthController();
    if (!controller?.humanMode) {
      rejectWebSocketUpgrade(socket, 403, 'Voice calls need a signed-in human');
      return;
    }
    if (!directory) {
      rejectWebSocketUpgrade(socket, 400, 'Voice needs a project directory');
      return;
    }
    void Promise.resolve(controller.requireUpgradeAuth(req, socket,
      () => connect(req, socket, head, decodeURIComponent(match[1]), directory), rejectWebSocketUpgrade))
      .catch(() => rejectWebSocketUpgrade(socket, 500, 'Upgrade failed'));
  };
  server.on('upgrade', upgradeHandler);
  return {
    stop() {
      server.off('upgrade', upgradeHandler);
      for (const client of browsers.clients) client.terminate();
      browsers.close();
    },
  };
};
