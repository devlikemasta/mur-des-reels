// Le pont entre le mur et ce qui travaille derrière : Claude Code et le navigateur de l'agent.
// Il sert le mur (dossier dist/), les miniatures et les captures des recherches (/run/…), et ouvre une
// connexion WebSocket sur /ws. Il n'écoute que sur ton ordinateur (127.0.0.1), et refuse toute page qui ne
// vient pas du mur lui-même : un site web ne peut pas lancer une recherche à ta place.
//
//   node server/index.ts            le mur sur http://localhost:5050
//   node server/index.ts --open     … et l'ouvre dans le navigateur
//   node server/index.ts --dev      seulement le pont (le mur est servi par Vite, port 5176)
import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ClientMsg, ServerMsg } from '../shared/protocol.ts';
import { findClaude } from './claude.ts';
import { AgentBrowser } from './instagram.ts';
import { Mur, tilde } from './mur.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const args = new Set(process.argv.slice(2));
const DEV = args.has('--dev');
const PORT = Number(process.env.PORT ?? 5050);
const HOST = '127.0.0.1';
const DEV_PORT = 5176;

const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
  "font-src 'self' data:", "media-src 'self' blob: data:", "worker-src 'self' blob:",
  `connect-src 'self' ws://localhost:${PORT} ws://127.0.0.1:${PORT}`, "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'",
].join('; ');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.avif': 'image/avif', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg',
  '.txt': 'text/plain; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.map': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
};

const NOT_BUILT = `<!doctype html><html lang="fr"><meta charset="utf-8"><title>Le Mur des reels</title>
<body style="font:16px/1.6 system-ui;background:#040405;color:#f5f5f7;max-width:34em;margin:18vh auto;padding:0 24px">
<h1 style="font-size:22px">Le mur n’est pas encore construit</h1>
<p>Le pont tourne, mais la page n’a pas été compilée. Dans le dossier du projet, arrête ce programme (Ctrl + C) puis lance :</p>
<pre style="background:#17171b;padding:12px 16px;border-radius:10px">npm start</pre></body></html>`;

const claude = await findClaude();
const BUILD = (() => { try { return String(Math.round(statSync(path.join(DIST, 'index.html')).mtimeMs)); } catch { return 'dev'; } })();
const clients = new Set<WebSocket>();

function broadcast(m: ServerMsg) {
  const s = JSON.stringify(m);
  for (const c of clients) if (c.readyState === c.OPEN) c.send(s);
}

const browser = new AgentBrowser((ig) => broadcast({ t: 'ig', ig }));
const mur = new Mur(claude, browser, broadcast, process.env.MUR_DIR);
await mur.init();

async function sendFile(file: string, req: http.IncomingMessage, res: http.ServerResponse, cache: string) {
  const body = await readFile(file);
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'Content-Type': TYPES[ext] ?? 'application/octet-stream',
    'Cache-Control': cache,
    'X-Content-Type-Options': 'nosniff',
    ...(ext === '.html' ? { 'Content-Security-Policy': CSP } : {}),
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

const server = http.createServer(async (req, res) => {
  let pathname = '';
  try { pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
  try {
    // les miniatures et les captures d'une recherche
    const r = /^\/run\/([a-z0-9]{1,20})\/([tsf])\/([A-Za-z0-9_-]{1,48}\.jpg)$/.exec(pathname);
    if (r) {
      const f = mur.file(r[1], r[2] as 't' | 's' | 'f', r[3]);
      if (!f) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Introuvable.'); return; }
      await sendFile(f, req, res, 'private, max-age=86400');
      return;
    }
    if (DEV) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`Mode développement : le mur est sur http://localhost:${DEV_PORT}`); return; }
    if (!existsSync(path.join(DIST, 'index.html'))) {
      res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" }).end(NOT_BUILT);
      return;
    }
    let file = path.normalize(path.join(DIST, pathname));
    if (file !== DIST && !file.startsWith(DIST + path.sep)) { res.writeHead(403).end(); return; }
    const missing = !existsSync(file) || file === DIST || file.endsWith(path.sep) || !statSync(file).isFile();
    // un fichier introuvable (une image, la démo) : 404 ; une adresse de page : le mur
    if (missing && path.extname(pathname)) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Introuvable.'); return; }
    if (missing) file = path.join(DIST, 'index.html');
    await sendFile(file, req, res, file.endsWith('.html') ? 'no-cache' : 'public, max-age=3600');
  } catch {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Erreur.');
  }
});

// Seul le mur lui-même peut se connecter (et, en développement, la page servie par Vite).
const allowedOrigins = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`, ...(DEV ? [`http://localhost:${DEV_PORT}`, `http://127.0.0.1:${DEV_PORT}`] : [])]);
const wss = new WebSocketServer({ noServer: true, maxPayload: 100_000 });

server.on('upgrade', (req, socket, head) => {
  const origin = req.headers.origin ?? '';
  let pathname = '';
  try { pathname = new URL(req.url ?? '/', 'http://x').pathname; } catch { /* refusé plus bas */ }
  if (pathname !== '/ws' || !allowedOrigins.has(origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
  const send = (m: ServerMsg) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)); };
  send({ t: 'hello', ...mur.hello(), build: BUILD });
  ws.on('message', async (data) => {
    let m: ClientMsg;
    try { m = JSON.parse(String(data)); } catch { return; }
    if (!m || typeof m !== 'object') return;
    try {
      await handle(m, send);
    } catch (e) {
      send({ t: 'toast', kind: 'error', text: e instanceof Error ? e.message : String(e) });
    }
  });
});

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

async function handle(m: ClientMsg, send: (m: ServerMsg) => void) {
  switch (m.t) {
    case 'connect': await browser.connect(); break;
    case 'start': await mur.start(str(m.niche, 200)); break;
    case 'stop': mur.stop(); break;
    case 'replay': { const r = await mur.replay(str(m.id, 40)); send({ t: 'replay', ...r }); break; }
    case 'open': mur.open(m.id ? str(m.id, 40) : undefined); break;
  }
}

server.once('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`  Le port ${PORT} est déjà pris : le mur tourne peut-être déjà (http://localhost:${PORT}).`);
    process.exit(1);
  }
  throw e;
});
server.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}`;
  console.log('');
  console.log('  🧱  Le Mur des reels');
  console.log(`  ➜  ${DEV ? `Pont prêt (le mur : http://localhost:${DEV_PORT})` : url}`);
  console.log(`  📁  Les recherches : ${tilde(mur.runsDir)}`);
  console.log(claude ? `  ✓  Claude Code ${claude.version}` : '  ✗  Claude Code introuvable : le mur tournera en démo.');
  console.log(browser.status.browser ? `  ✓  Navigateur de l’agent : ${browser.status.browser}` : '  ✗  Aucun navigateur Chromium trouvé (Chrome, Brave, Edge ou Arc).');
  console.log('  ⏹  Pour arrêter : Ctrl + C');
  console.log('');
  if (args.has('--open') && !DEV) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    execFile(opener, [url], () => {});
  }
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    mur.shutdown();
    setTimeout(() => process.exit(0), 600);
  });
}
