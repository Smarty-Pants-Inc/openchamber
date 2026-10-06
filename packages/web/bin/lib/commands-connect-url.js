import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { EXIT_CODE, TunnelCliError } from './cli-errors.js';
import {
  assertSafeBrowserPort,
  resolveConfiguredBindHost,
  buildLocalUrl,
  detectLanIPv4Address,
  formatHostForUrl,
} from './cli-network.js';
import { discoverRunningInstances } from './cli-lifecycle.js';
import { getInstanceFilePath, readInstanceOptions } from './cli-process.js';
import { createRemoteClientAuthRuntime } from '../../server/lib/client-auth/remote-clients.js';
import { createClientPairingRuntime } from '../../server/lib/client-auth/pairing.js';
import {
  intro as clackIntro,
  outro as clackOutro,
  log as clackLog,
  isJsonMode,
  isQuietMode,
  printJson,
  logStatus,
} from '../cli-output.js';
import { PRODUCT_NAME } from '../../brand.generated.js';

const REMOTE_CLIENTS_FILE_NAME = 'remote-clients.json';
const PAIRING_SESSIONS_FILE_NAME = 'client-pairing-sessions.json';

// Pairing runtime backed by the same on-disk store the running host reads, so a
// session created here is redeemable by the live server. createPairingSession
// only writes the store (no server needed to mint); redeem is served by the host.
function createCliPairingRuntime() {
  const dataDir = getOpenChamberDataDir();
  const remoteClientAuthRuntime = createRemoteClientAuthRuntime({
    fsPromises: fs.promises,
    path,
    crypto,
    storePath: path.join(dataDir, REMOTE_CLIENTS_FILE_NAME),
  });
  return createClientPairingRuntime({
    fsPromises: fs.promises,
    path,
    crypto,
    storePath: path.join(dataDir, PAIRING_SESSIONS_FILE_NAME),
    remoteClientAuthRuntime,
  });
}

// Mirror of encodePairingConnectionPayload in @openchamber/ui (the bin cannot
// import the UI package). Keep in sync: v2 payload → base64url(JSON) in the URL
// query, so the one-time secret rides the link, never the network.
function encodePairingConnectUrl(payload) {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `openchamber://connect?v=2&p=${encoded}`;
}

function buildPairingPayload({ pairing, label, candidates }) {
  return {
    v: 2,
    pairingId: pairing.id,
    secret: pairing.secret,
    ...(label ? { label } : {}),
    ...(pairing.fingerprint ? { fingerprint: pairing.fingerprint } : {}),
    ...(pairing.expiresAt ? { expiresAt: pairing.expiresAt } : {}),
    candidates,
  };
}

async function resolveConnectUrlServerUrl(options) {
  let hostOverride = options.host;
  if (typeof hostOverride !== 'string' && !process.env.OPENCHAMBER_HOST) {
    const storedOptions = readInstanceOptions(await getInstanceFilePath(options.port));
    if (typeof storedOptions?.host === 'string' && storedOptions.host.trim()) {
      hostOverride = storedOptions.host.trim();
    }
  }

  const bindHost = resolveConfiguredBindHost(hostOverride);

  // A host that's already a full http(s) URL is a public/server URL, not a bind
  // address (e.g. `--host https://devchamber.example.com` for a remote deploy
  // behind a reverse proxy). Use it directly instead of feeding it to
  // buildLocalUrl, which would produce `http://https://...:port`.
  const hostAsServerUrl = normalizeServerUrlForConnection(bindHost);
  if (hostAsServerUrl) {
    return { serverUrl: hostAsServerUrl, source: 'configured-host' };
  }

  if (!isWildcardBindHost(bindHost)) {
    return {
      serverUrl: buildLocalUrl(options.port, '/', hostOverride).replace(/\/+$/, ''),
      source: 'configured-host',
    };
  }

  const lanAddress = await detectLanIPv4Address();
  if (!lanAddress) {
    return {
      serverUrl: buildLocalUrl(options.port, '/').replace(/\/+$/, ''),
      source: 'loopback-fallback',
    };
  }

  return {
    serverUrl: `http://${formatHostForUrl(lanAddress)}:${options.port}`,
    source: 'lan-detected',
  };
}

function isWildcardBindHost(host) {
  return host === '0.0.0.0' || host === '::' || host === '[::]';
}

function isLoopbackServerUrl(serverUrl) {
  try {
    const hostname = new URL(serverUrl).hostname.replace(/^\[|\]$/g, '');
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  } catch {
    return false;
  }
}

function normalizeServerUrlForConnection(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function getOpenChamberDataDir() {
  return process.env.OPENCHAMBER_DATA_DIR
    ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
    : path.join(os.homedir(), '.config', 'openchamber');
}

async function displayQrCode(url) {
  try {
    const qrcode = await import('qrcode-terminal');
    console.log('\n📱 Scan this QR code to access the tunnel:\n');
    qrcode.default.generate(url, { small: true });
    console.log('');
  } catch (error) {
    console.warn(`Warning: Could not generate QR code: ${error.message}`);
  }
}

function createConnectUrlCommand({ serveCommand }) {
  return async function connectUrlCommand(options = {}) {
    assertSafeBrowserPort(options.port, { context: `${PRODUCT_NAME} connect-url` });
    const explicitServerUrl = options.server ? normalizeServerUrlForConnection(options.server) : null;
    if (options.server && !explicitServerUrl) {
      throw new TunnelCliError('Invalid --server URL. Use an http:// or https:// URL.', EXIT_CODE.USAGE_ERROR);
    }

    const running = await discoverRunningInstances();
    const serverState = running.some((entry) => entry.port === options.port)
      ? { port: options.port, autoStarted: false }
      : await (async () => {
          await serveCommand({
            port: options.port,
            explicitPort: true,
            host: options.host,
            uiPassword: options.uiPassword,
            apiOnly: options.apiOnly,
            suppressUnsafePortWarning: true,
            suppressUiPasswordWarning: true,
            suppressStartupSummary: true,
            suppressQuietOutput: true,
          });
          return { port: options.port, autoStarted: true };
        })();

    const resolvedServerUrl = explicitServerUrl
      ? { serverUrl: explicitServerUrl, source: 'explicit' }
      : await resolveConnectUrlServerUrl(options);
    const serverUrl = resolvedServerUrl.serverUrl;
    const label = options.name || os.hostname();

    const candidates = [{ type: serverUrl.startsWith('https://') ? 'tunnel' : 'lan', url: serverUrl, priority: 10 }];

    const pairingRuntime = createCliPairingRuntime();
    const { pairing } = await pairingRuntime.createPairingSession({ label });
    const connectUrl = encodePairingConnectUrl(buildPairingPayload({ pairing, label, candidates }));

    if (isJsonMode(options)) {
      printJson({
        serverUrl,
        connectUrl,
        pairingId: pairing.id,
        fingerprint: pairing.fingerprint,
        expiresAt: pairing.expiresAt,
        candidates,
        autoStarted: serverState.autoStarted,
      });
      return;
    }

    if (isQuietMode(options)) {
      process.stdout.write(`${connectUrl}\n`);
      return;
    }

    clackIntro(`${PRODUCT_NAME} pairing link`);
    if (serverState.autoStarted) {
      logStatus('success', `started ${PRODUCT_NAME} on port ${options.port}`);
    }
    logStatus('success', connectUrl);
    clackLog.info(`Server URL: ${serverUrl}`);
    if (pairing.fingerprint) {
      clackLog.info(`Fingerprint: ${pairing.fingerprint}`);
    }
    if (resolvedServerUrl.source === 'lan-detected') {
      clackLog.info(`Detected a LAN address because ${PRODUCT_NAME} is bound to all interfaces. Use --server to override it.`);
    } else if (resolvedServerUrl.source === 'loopback-fallback') {
      clackLog.warn(`${PRODUCT_NAME} is bound to all interfaces, but no LAN address was detected. Use --server to provide a reachable URL.`);
    } else if (isLoopbackServerUrl(serverUrl)) {
      // The direct candidate points at this machine only — other devices cannot
      // use it. Say so instead of letting a "LAN" link silently not work.
      logStatus('warn', '[LAN_UNREACHABLE]', `${PRODUCT_NAME} only listens on this machine, so other devices cannot use this link. Restart with --lan, or use --server to provide a reachable URL.`);
    }
    clackLog.info(`Scan or paste this link into another ${PRODUCT_NAME} client. It is single-use and expires.`);
    if (options.qr === true) {
      await displayQrCode(connectUrl);
    }
    clackOutro('pairing link generated');
  };
}

export { createConnectUrlCommand };
