'use strict';
const dgram = require('node:dgram');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');

// ---- Network configuration ------------------------------------------------
// Priority: command-line flags > environment variables > config.json > defaults.
//   bind: "local" (default, this PC only) | "lan" (all interfaces) | a specific IP of this PC
function loadConfig() {
  let file = {};
  const cfgPath = path.join(__dirname, 'config.json');
  if (fs.existsSync(cfgPath)) { try { file = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (e) { console.error(`config.json is not valid JSON: ${e.message}`); process.exit(1); } }
  const arg = (name) => { const a = process.argv.find((x) => x === `--${name}` || x.startsWith(`--${name}=`)); return a && (a.includes('=') ? a.split('=').slice(1).join('=') : true); };
  const list = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((x) => String(x).trim()).filter(Boolean);
  const bind = String((arg('lan') && 'lan') || (arg('local') && 'local') || arg('bind') || process.env.BIND || process.env.HOST || file.bind || 'local').trim();
  const port = Number(arg('port') || process.env.PORT || file.port || 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) { console.error(`Invalid port: ${port}`); process.exit(1); }
  const host = bind === 'local' || bind === 'localhost' ? '127.0.0.1' : bind === 'lan' ? '0.0.0.0' : bind;
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) { console.error(`Invalid bind "${bind}". Use "local", "lan", or an IPv4 address of this PC.`); process.exit(1); }
  return { host, port, allowedHosts: list(arg('allowed-hosts') || process.env.ALLOWED_HOSTS || file.allowedHosts), allowedClients: list(arg('allowed-clients') || process.env.ALLOWED_CLIENTS || file.allowedClients) };
}
const CONFIG = loadConfig();
const HOST = CONFIG.host, PORT = CONFIG.port, LOCAL_ONLY = HOST.startsWith('127.'), FOUND_TTL_MS = 60 * 60 * 1000, WIZ_PORT = 38899;
const DATA = path.join(__dirname, 'data', 'devices.json');
const UI = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
const key = (mac) => String(mac).replace(/[^a-f0-9]/gi, '').toLowerCase();
const macText = (mac) => key(mac).match(/../g).join(':').toUpperCase();

function privateIp(ip) {
  const p = String(ip).split('.').map(Number);
  return p.length === 4 && p.every((x) => Number.isInteger(x) && x >= 0 && x < 256) &&
    (p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168));
}
function load() { try { return JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch { return []; } }
function save() { fs.mkdirSync(path.dirname(DATA), { recursive: true }); fs.writeFileSync(DATA, `${JSON.stringify(devices, null, 2)}\n`, { mode: 0o600 }); }
let devices = load();
function find(id) { const d = devices.find((x) => x.id === id); if (!d) throw Error('Unknown lamp.'); return d; }
const MAX_FOUND = 256, found = new Map(); // lamps seen on the LAN but not necessarily on the dashboard
function remember({ ip, mac, model, firmware }) {
  const id = key(mac), old = devices.find((x) => x.id === id), prev = found.get(id);
  const d = { id, ip, mac: macText(mac), name: old?.name || prev?.name || `WiZ ${macText(mac).slice(-5)}`, model: model || old?.model || prev?.model || 'WiZ lamp', firmware: firmware || old?.firmware || prev?.firmware || null, lastSeen: new Date().toISOString() };
  if (!found.has(id)) { pruneFound(); if (found.size >= MAX_FOUND) return null; }
  found.set(id, d);
  // SEC-002: never silently move a saved lamp to a new address; the user confirms it.
  if (old && old.ip === d.ip) { Object.assign(old, { model: d.model, firmware: d.firmware, lastSeen: d.lastSeen }); save(); }
  return d;
}
// Found lamps not heard from in 1h are forgotten (dashboard lamps are never touched by this).
function pruneFound() { const cutoff = Date.now() - FOUND_TTL_MS; for (const [id, d] of found) if (!devices.some((x) => x.id === id) && Date.parse(d.lastSeen) < cutoff) found.delete(id); }
function seen(id) { const f = found.get(id); if (f) f.lastSeen = new Date().toISOString(); }
function listFound() { pruneFound(); return [...found.values()].map((d) => { const s = devices.find((x) => x.id === d.id); return { ...d, added: !!s, ipChanged: !!s && s.ip !== d.ip, savedIp: s?.ip || null }; }); }
function addDevice(id, name) {
  const f = found.get(id); if (!f) throw Error('Lamp not found. Run discovery first.');
  let d = devices.find((x) => x.id === id);
  if (!d) { d = { ...f }; devices.push(d); } else { d.ip = f.ip; d.lastSeen = f.lastSeen; }
  const n = String(name || '').trim().slice(0, 64); if (n) d.name = n;
  save(); return d;
}
function removeDevice(id) { const i = devices.findIndex((x) => x.id === id); if (i < 0) throw Error('Unknown lamp.'); const [d] = devices.splice(i, 1); found.set(id, { ...d }); save(); return d; }
async function probeIp(ip) { const x = await udp(ip, 'getSystemConfig'); if (!x.result?.mac) throw Error('Not a WiZ lamp.'); return remember({ ip, mac: x.result.mac, model: x.result.moduleName, firmware: x.result.fwVersion }); }
function subnet(text) {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d|[12]\d|3[0-2])$/.exec(text || '');
  if (!m) throw Error('Enter a subnet like 192.168.1.0/24.');
  const p = m.slice(1, 5).map(Number), bits = Number(m[5]);
  if (p.some((x) => x > 255) || bits < 24 || !privateIp(p.join('.'))) throw Error('Discovery is limited to a private /24 (or smaller).');
  const raw = p.reduce((n, x) => (n << 8) + x, 0) >>> 0, mask = (0xffffffff << (32 - bits)) >>> 0, base = (raw & mask) >>> 0, count = 2 ** (32 - bits);
  const ip = (n) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');
  return { broadcast: ip((base + count - 1) >>> 0), hosts: Array.from({ length: count <= 2 ? count : count - 2 }, (_, i) => ip(base + (count <= 2 ? i : i + 1))) };
}
function udp(ip, method, params = {}) {
  if (!privateIp(ip)) throw Error('Only private LAN addresses are allowed.');
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4'); let done = false;
    const finish = (err, value) => { if (done) return; done = true; clearTimeout(timer); s.close(); err ? reject(err) : resolve(value); };
    const timer = setTimeout(() => finish(Error(`No reply from ${ip}:${WIZ_PORT}.`)), 2500);
    s.once('error', (e) => finish(e));
    s.on('message', (b, r) => { if (r.address !== ip || r.port !== WIZ_PORT) return; try { const x = JSON.parse(b); if (x.method === method) finish(null, x); } catch { finish(Error('Malformed lamp response.')); } });
    s.send(Buffer.from(JSON.stringify({ method, params })), WIZ_PORT, ip, (e) => e && finish(e));
  });
}
let scanning = false;
async function discover(range) {
  if (scanning) throw Error('A scan is already running.');
  scanning = true; pruneFound();
  try { return await sweep(range); } finally { scanning = false; }
}
function sweep(range) {
  const probe = Buffer.from(JSON.stringify({ method: 'registration', params: { phoneMac: 'AAAAAAAAAAAA', register: false, phoneIp: '1.2.3.4', id: 'wiz-local-v2' } }));
  const config = Buffer.from(JSON.stringify({ method: 'getSystemConfig', params: {} }));
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true }), found = new Map(); let done = false;
    const finish = (e) => { if (done) return; done = true; clearTimeout(timer); s.close(); e ? reject(e) : resolve([...found.values()]); };
    const timer = setTimeout(() => finish(), 4200);
    s.once('error', finish);
    s.on('message', (b, r) => { try { const x = JSON.parse(b), q = x.result; if (q?.mac && privateIp(r.address)) found.set(key(q.mac), remember({ ip: r.address, mac: q.mac, model: q.moduleName, firmware: q.fwVersion })); } catch {} });
    s.bind(0, () => { s.setBroadcast(true); s.send(probe, WIZ_PORT, range.broadcast); for (const ip of range.hosts) s.send(config, WIZ_PORT, ip); setTimeout(() => s.send(probe, WIZ_PORT, range.broadcast), 1000); });
  });
}
function pilot(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error('JSON object required.');
  const limits = { dimming: [1, 100], temp: [2200, 6500], r: [0, 255], g: [0, 255], b: [0, 255], sceneId: [0, 255] }, out = {};
  for (const [k, v] of Object.entries(body)) {
    if (k === 'state') { if (typeof v !== 'boolean') throw Error('state must be true or false.'); out[k] = v; continue; }
    const lim = limits[k]; if (!lim || !Number.isInteger(v) || v < lim[0] || v > lim[1]) throw Error(`Invalid ${k}.`); out[k] = v;
  }
  if (!Object.keys(out).length) throw Error('A control is required.'); return out;
}
function json(res, code, body) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(body)); }
function body(req) { return new Promise((resolve, reject) => { let raw = ''; req.setEncoding('utf8'); req.on('data', (x) => { raw += x; if (raw.length > 4096) { reject(Error('Request too large.')); req.destroy(); } }); req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { reject(Error('Invalid JSON.')); } }); req.on('error', reject); }); }
// Host/Origin allowlist (blocks DNS rebinding): this PC's own addresses plus any names in ALLOWED_HOSTS.
function allowedHosts() {
  const ips = ['127.0.0.1', 'localhost'];
  if (!LOCAL_ONLY) {
    if (HOST !== '0.0.0.0') ips.push(HOST);
    else for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' || a.family === 4) ips.push(a.address);
    ips.push(...CONFIG.allowedHosts);
  }
  return new Set(ips.flatMap((h) => (h.includes(':') ? [h] : [`${h}:${PORT}`, ...(PORT === 80 ? [h] : [])])));
}
let ALLOWED = allowedHosts(); setInterval(() => { ALLOWED = allowedHosts(); }, 60 * 1000).unref();
const CLIENTS = CONFIG.allowedClients;
const server = http.createServer(async (req, res) => {
  try {
    // SEC-001: block DNS rebinding and cross-site requests from other web pages.
    const peer = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (CLIENTS.length && peer !== '127.0.0.1' && !CLIENTS.includes(peer)) return json(res, 403, { error: 'Client not allowed.' });
    if (!ALLOWED.has(req.headers.host)) return json(res, 421, { error: 'Bad host.' });
    if (req.method !== 'GET') {
      const o = req.headers.origin;
      if (o && !ALLOWED.has(o.replace(/^http:\/\//, ''))) return json(res, 403, { error: 'Bad origin.' });
      if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) return json(res, 403, { error: 'Cross-site request blocked.' });
      if (req.method === 'POST' && !/^application\/json\b/i.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'JSON required.' });
    }
    if (req.method === 'GET' && req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'" }); return res.end(UI); }
    if (req.method === 'GET' && req.url === '/api/devices') return json(res, 200, { devices });
    if (req.method === 'POST' && req.url === '/api/discover') { await discover(subnet((await body(req)).subnet)); return json(res, 200, { found: listFound() }); }
    if (req.method === 'GET' && req.url === '/api/found') return json(res, 200, { found: listFound() });
    if (req.method === 'POST' && req.url === '/api/probe') { const ip = String((await body(req)).ip || '').trim(); await probeIp(ip); return json(res, 200, { found: listFound() }); }
    if (req.method === 'POST' && req.url === '/api/devices') { const b = await body(req); return json(res, 200, { device: addDevice(key(b.id || ''), b.name) }); }
    const r = /^\/api\/devices\/([a-f0-9]{12})$/.exec(req.url || '');
    if (r && req.method === 'DELETE') return json(res, 200, { device: removeDevice(r[1]) });
    const m = /^\/api\/devices\/([a-f0-9]{12})\/(state|pilot|name)$/.exec(req.url || ''); if (!m) return json(res, 404, { error: 'Not found.' });
    const d = find(m[1]);
    if (req.method === 'GET' && m[2] === 'state') { const x = await udp(d.ip, 'getPilot'); seen(d.id); return json(res, 200, x); }
    if (req.method === 'POST' && m[2] === 'pilot') return json(res, 200, await udp(d.ip, 'setPilot', pilot(await body(req))));
    if (req.method === 'POST' && m[2] === 'name') { const name = String((await body(req)).name || '').trim().slice(0, 64); if (!name) throw Error('A name is required.'); d.name = name; save(); return json(res, 200, { device: d }); }
    return json(res, 405, { error: 'Method not allowed.' });
  } catch (e) { json(res, 400, { error: e.message || 'Request failed.' }); }
});
server.on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Choose another with --port=XXXX.` : e.code === 'EADDRNOTAVAIL' ? `${HOST} is not an address of this PC.` : e.message); process.exit(1); });
server.listen(PORT, HOST, () => {
  console.log(`WiZ Local Controller listening on ${HOST}:${PORT}`);
  if (LOCAL_ONLY) console.log(`Mode: local - only this PC can open http://127.0.0.1:${PORT}  (start with --lan to allow other devices)`);
  else {
    console.log(`Mode: LAN - other devices that can reach this PC may open:`);
    for (const h of [...ALLOWED].filter((x) => !/^(localhost|127\.)/.test(x))) console.log(`  http://${h}`);
    console.log(CLIENTS.length ? `Allowed clients: ${CLIENTS.join(', ')}` : 'Allowed clients: any (restrict with your firewall or allowedClients). The app has no login.');
  }
});
