import assert from 'node:assert/strict';
import http from 'node:http';
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
const home = fs.mkdtempSync(path.join(process.env.TMPDIR, 'terminal-removed-'));
fs.chmodSync(home, 0o700);
Object.assign(process.env, {
 HOME: home, XDG_CONFIG_HOME: `${home}/config`, XDG_DATA_HOME: `${home}/share`, XDG_STATE_HOME: `${home}/state`, XDG_RUNTIME_DIR: home,
 OPENCHAMBER_DATA_DIR: `${home}/data`, OPENCHAMBER_RELAY_HOST: 'off', OPENCODE_SKIP_START: 'true',
 OPENCHAMBER_HUMAN_AUTH: 'google', OPENCHAMBER_HUMAN_AUTH_DB: `${home}/auth.sqlite`,
 BETTER_AUTH_URL: 'https://code.smartypants.ai', BETTER_AUTH_SECRET: 'private-fixture-only-thirty-two-character-secret',
 GOOGLE_CLIENT_ID: 'fixture-client', GOOGLE_CLIENT_SECRET: 'fixture-secret', SMARTY_HUMAN_AUTH_ALLOWED_DOMAINS: 'example.test', OPENCHAMBER_ALLOWED_HOSTS: 'code.smartypants.ai',
});
delete process.env.SMARTY_CODE_NODE_ID;
delete process.env.SMARTY_NODE_RECORD;
// The existing generic OpenCode proxy still forwards unknown API paths. The
// upstream fixture, like OpenCode, has no OpenChamber terminal namespace.
const upstream = http.createServer((req, res) => {
 res.setHeader('Content-Type','application/json');
 if (req.url.includes('health')) return res.end('{"healthy":true}');
 res.writeHead(404); res.end('{"error":"Not Found"}');
});
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
let runtime, human;
try {
 const { createConfiguredHumanAuth } = await import(`${source}/packages/web/server/lib/ui-auth/human-auth-config.js`);
 human = await createConfiguredHumanAuth(process.env);
 const seed = betterAuth({...human.auth.options,user:{...human.auth.options.user,validateUserInfo:undefined},plugins:[testUtils()]});
 const helpers = (await seed.$context).test;
 const user = await helpers.saveUser(helpers.createUser({email:'fixture@example.test',emailVerified:true}));
 const headers = Object.fromEntries(await helpers.getAuthHeaders({userId:user.id}));
 const {startWebUiServer} = await import(`${source}/packages/web/server/index.js`);
 runtime = await startWebUiServer({port:0,host:'127.0.0.1',attachSignals:false,exitOnShutdown:false,apiOnly:true});
 runtime.httpServer.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
 const app = runtime.httpServer.listeners('request')[0];
 const registeredPaths = app.router.stack.flatMap(layer => layer.route ? [layer.route.path] : []);
 assert.equal(registeredPaths.some(route => String(route).includes('/api/terminal')), false, 'No terminal route may remain registered');
 const base = `http://127.0.0.1:${runtime.getPort()}`;
 const authHeaders = auth => ({Host:'code.smartypants.ai',Origin:'https://code.smartypants.ai',...auth});
 for (const [label, auth] of [['signed-out',{}],['signed-in',headers]]) {
   if (label === 'signed-in') assert.equal((await fetch(`${base}/api/config/settings`, {headers:authHeaders(auth)})).status, 200, 'Control proves valid human session');
   for (const [method, route] of routes) {
     const res = await fetch(`${base}${route}`, {method,headers:authHeaders(auth),signal:AbortSignal.timeout(5000)});
     const body = await res.text();
     assert.equal(res.status,label==='signed-in'?404:401, `${label} ${method} ${route}: ${body}`);
     results.push({label,method,route,status:res.status});
     console.log(`AFTER ${label} ${method} ${route} => ${res.status}`);
   }
   // Upgrade every former HTTP path too: none must accidentally become a WS
   // ingress after deletion. Other WS handlers ignore unknown paths, so the
   // client's bounded handshake expires rather than accepting an upgrade.
   for (const [, route] of routes) {
     const outcome = await new Promise((resolve,reject) => {
       const socket = new WebSocket(`${base.replace('http:','ws:')}${route}`, {headers:authHeaders(auth),handshakeTimeout:100});
       socket.once('open',()=>{socket.terminate();reject(new Error(`Unexpected upgrade: ${label} ${route}`));});
       socket.once('unexpected-response',(_req,res)=>{res.resume();socket.terminate();resolve(res.statusCode);});
       socket.on('error', error => { if (error.message.includes('Opening handshake has timed out') || error.code === 'ECONNRESET') resolve('rejected'); else reject(error); });
     });
     results.push({label,method:'WS',route,status:outcome});
     console.log(`AFTER ${label} WS ${route} => ${outcome}`);
   }
 }
 const { isAllowedRelayWebSocketPath } = await import(`${source}/packages/web/server/lib/relay/tunnel-host.js`);
 assert.equal(isAllowedRelayWebSocketPath('/api/terminal/ws'), false);
 assert.equal(isAllowedRelayWebSocketPath('/api/global/event/ws'), true);
 assert.equal(externalAttempts, 0);
} finally {
 for (const socket of sockets) socket.destroy();
 await runtime?.stop({exitProcess:false}); human?.dispose();
 upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));
 fs.rmSync(home,{recursive:true,force:true});
}
console.log('TERMINAL_REMOVAL_RECEIPT='+JSON.stringify({results,stopped:true,externalAttempts}));
process.exit(0);
