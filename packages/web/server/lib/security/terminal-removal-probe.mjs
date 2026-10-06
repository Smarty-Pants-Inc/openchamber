import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const source = process.env.TERMINAL_PROBE_SOURCE || process.cwd();
const require = createRequire(`${source}/packages/web/package.json`);
const { betterAuth } = require('better-auth');
const { testUtils } = require('better-auth/plugins');
const { WebSocket } = require('ws');
const routes = [
  ['GET', '/api/terminal/shells'], ['GET', '/api/terminal/sessions'],
  ['POST', '/api/terminal/touch'], ['POST', '/api/terminal/create'],
  ['POST', '/api/terminal/removed-fixture/resize'], ['POST', '/api/terminal/removed-fixture/appearance'],
  ['POST', '/api/terminal/removed-fixture/restart'], ['DELETE', '/api/terminal/removed-fixture'],
  ['POST', '/api/terminal/force-kill'], ['GET', '/api/terminal/ws'],
];
// Spellings that reach the same retired namespace through Express's
// case-insensitive mount, percent-encoding, repeated slashes or dot segments.
const variants = [
  ['GET', '/api/terminal'], ['GET', '/API/Terminal/ws'], ['GET', '/api/%74erminal/sessions'],
  ['POST', '/api//terminal/create'], ['GET', '/api/session/../terminal/shells'],
];
const UPSTREAM_SENTINEL = 'UPSTREAM_SUCCESS_SENTINEL_552';
const INDEX_SENTINEL = 'SERVED_INDEX_SENTINEL_552';
const home = fs.mkdtempSync(path.join(process.env.TMPDIR, 'terminal-removed-'));
fs.chmodSync(home, 0o700);
Object.assign(process.env, {
 HOME: home, XDG_CONFIG_HOME: `${home}/config`, XDG_DATA_HOME: `${home}/share`, XDG_STATE_HOME: `${home}/state`, XDG_RUNTIME_DIR: home,
 OPENCHAMBER_DATA_DIR: `${home}/data`, OPENCHAMBER_RELAY_HOST: 'off', OPENCODE_SKIP_START: 'true',
 // Server-owned upstream credential, as in production: a forward would carry it.
 OPENCODE_SERVER_PASSWORD: 'fixture-upstream-password',
 OPENCHAMBER_HUMAN_AUTH: 'google', OPENCHAMBER_HUMAN_AUTH_DB: `${home}/auth.sqlite`,
 BETTER_AUTH_URL: 'https://code.smartypants.ai', BETTER_AUTH_SECRET: 'private-fixture-only-thirty-two-character-secret',
 GOOGLE_CLIENT_ID: 'fixture-client', GOOGLE_CLIENT_SECRET: 'fixture-secret', SMARTY_HUMAN_AUTH_ALLOWED_DOMAINS: 'example.test', OPENCHAMBER_ALLOWED_HOSTS: 'code.smartypants.ai',
});
// Served-app mode with an identifiable index: a retired path must never fall back to it.
fs.mkdirSync(`${home}/dist`, { recursive: true });
fs.writeFileSync(`${home}/dist/index.html`, `<!doctype html><title>${INDEX_SENTINEL}</title>`);
process.env.OPENCHAMBER_DIST_DIR = `${home}/dist`;
delete process.env.SMARTY_CODE_NODE_ID;
delete process.env.SMARTY_NODE_RECORD;
// The generic OpenCode proxy forwards unknown API paths. This upstream answers
// every one with a conspicuous success, so an accidental forward cannot pass
// as a refusal, and it records every retired-namespace request it receives.
const upstreamRetired = [];
const upstream = http.createServer((req, res) => {
 res.setHeader('Content-Type','application/json');
 if (req.url.includes('health')) return res.end('{"healthy":true}');
 if (/terminal/i.test(decodeURIComponent(req.url))) upstreamRetired.push(`${req.method} ${req.url} auth=${Boolean(req.headers.authorization)}`);
 res.writeHead(200); res.end(JSON.stringify({ sentinel: UPSTREAM_SENTINEL }));
});
upstream.on('upgrade', (req, socket) => { upstreamRetired.push(`UPGRADE ${req.url}`); socket.destroy(); });
await new Promise(resolve => upstream.listen(0,'127.0.0.1',resolve));
process.env.OPENCODE_HOST = `http://127.0.0.1:${upstream.address().port}`;
const originalFetch = globalThis.fetch;
let externalAttempts = 0;
globalThis.fetch = (input, options) => {
 const target = new URL(input instanceof Request ? input.url : String(input));
 if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) {
   externalAttempts++; return Promise.reject(new Error('Fixture refuses external network'));
 }
 return originalFetch(input, options);
};
const results = [];
const sockets = new Set();
let runtime, human, firstUpgradeListener;
try {
 const { createConfiguredHumanAuth } = await import(`${source}/packages/web/server/lib/ui-auth/human-auth-config.js`);
 human = await createConfiguredHumanAuth(process.env);
 const seed = betterAuth({...human.auth.options,user:{...human.auth.options.user,validateUserInfo:undefined},plugins:[testUtils()]});
 const helpers = (await seed.$context).test;
 const user = await helpers.saveUser(helpers.createUser({email:'fixture@example.test',emailVerified:true}));
 const headers = Object.fromEntries(await helpers.getAuthHeaders({userId:user.id}));
 const {startWebUiServer} = await import(`${source}/packages/web/server/index.js`);
 runtime = await startWebUiServer({port:0,host:'127.0.0.1',attachSignals:false,exitOnShutdown:false,apiOnly:false});
 runtime.httpServer.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
 const app = runtime.httpServer.listeners('request')[0];
 const registeredPaths = app.router.stack.flatMap(layer => layer.route ? [layer.route.path] : []);
 assert.equal(registeredPaths.some(route => String(route).includes('/api/terminal')), false, 'No terminal route may remain registered');
 firstUpgradeListener = runtime.httpServer.listeners('upgrade')[0]?.name || 'none';
 const base = `http://127.0.0.1:${runtime.getPort()}`;
 const port = runtime.getPort();
 const authHeaders = auth => ({Host:'code.smartypants.ai',Origin:'https://code.smartypants.ai',...auth});
 // Raw upgrade: pass only on a server-written refusal status followed by a
 // server-initiated close. A client deadline is a failure, never a refusal.
 const rawUpgrade = (route, auth) => new Promise(resolve => {
   const socket = net.connect(port, '127.0.0.1');
   let data = '';
   const finish = outcome => { clearTimeout(deadline); socket.destroy(); resolve(outcome); };
   const deadline = setTimeout(() => finish({ status: 'timeout', closedByServer: false, body: data }), 3000);
   socket.setEncoding('latin1');
   socket.on('data', chunk => { data += chunk; });
   socket.on('error', () => {});
   socket.once('close', () => {
     const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1]) || 'no-status';
     finish({ status, closedByServer: true, body: data });
   });
   socket.once('connect', () => {
     const headers = { ...authHeaders(auth), Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' };
     socket.write(`GET ${route} HTTP/1.1\r\n${Object.entries(headers).map(([key, value]) => `${key}: ${value}\r\n`).join('')}\r\n`);
   });
 });
 const indexControl = await fetch(`${base}/`, {headers:authHeaders({})});
 assert.ok((await indexControl.text()).includes(INDEX_SENTINEL), 'Control proves served-app index mode');
 for (const [label, auth] of [['signed-out',{}],['signed-in',headers]]) {
   if (label === 'signed-in') assert.equal((await fetch(`${base}/api/config/settings`, {headers:authHeaders(auth)})).status, 200, 'Control proves valid human session');
   for (const [method, route] of [...routes, ...variants]) {
     const res = await fetch(`${base}${route}`, {method,headers:authHeaders(auth),signal:AbortSignal.timeout(5000)});
     const body = await res.text();
     const leaked = body.includes(UPSTREAM_SENTINEL) || body.includes(INDEX_SENTINEL);
     results.push({label,method,route,status:res.status,leaked,variant:!routes.some(([, known]) => known === route)});
     console.log(`AFTER ${label} ${method} ${route} => ${res.status}${leaked ? ' LEAKED' : ''}`);
   }
   // Upgrade every former path too: the server itself must answer with a
   // refusal and close the raw socket.
   const upgradeRoutes = [...routes, ...variants].map(([, route]) => route);
   const outcomes = await Promise.all(upgradeRoutes.map(route => rawUpgrade(route, auth)));
   for (const [index, route] of upgradeRoutes.entries()) {
     const outcome = outcomes[index];
     results.push({label,method:'WS',route,status:outcome.status,closedByServer:outcome.closedByServer,variant:!routes.some(([, known]) => known === route)});
     console.log(`AFTER ${label} WS ${route} => ${outcome.status} closedByServer=${outcome.closedByServer}`);
   }
   // Remaining endpoint controls: the refusal must not open or break them.
   const control = await new Promise(resolve => {
     const socket = new WebSocket(`${base.replace('http:','ws:')}/api/global/event/ws`, {headers:authHeaders(auth),handshakeTimeout:3000});
     socket.once('open',()=>{socket.terminate();resolve(101);});
     socket.once('unexpected-response',(_req,res)=>{res.resume();socket.terminate();resolve(res.statusCode);});
     socket.on('error', error => resolve(`error:${error.message}`));
   });
   results.push({label,method:'CONTROL-WS',route:'/api/global/event/ws',status:control});
   console.log(`CONTROL ${label} WS /api/global/event/ws => ${control}`);
 }
 const { isAllowedRelayWebSocketPath } = await import(`${source}/packages/web/server/lib/relay/tunnel-host.js`);
 assert.equal(isAllowedRelayWebSocketPath('/api/terminal/ws'), false);
 assert.equal(isAllowedRelayWebSocketPath('/api/global/event/ws'), true);
 assert.equal(externalAttempts, 0);
} finally {
 console.log('UPSTREAM_RETIRED='+JSON.stringify(upstreamRetired));
 for (const socket of sockets) socket.destroy();
 await runtime?.stop({exitProcess:false}); human?.dispose();
 upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));
 fs.rmSync(home,{recursive:true,force:true});
}
console.log('TERMINAL_REMOVAL_RECEIPT='+JSON.stringify({results,stopped:true,externalAttempts,upstreamRetired,firstUpgradeListener}));
process.exit(0);
