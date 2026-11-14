// Le Mur des reels, côté navigateur : le mur en 3D, l'interface, le réalisateur, et la connexion au pont
// (le petit serveur local qui pilote Claude Code et le navigateur de l'agent). Sans pont, on rejoue une
// recherche enregistrée.
import './styles.css';
import type { ClientMsg, Logged, RunInfo, ServerMsg } from '../shared/protocol.ts';
import { Director } from './director.ts';
import { Wall } from './scene/wall.ts';
import { UI } from './ui.ts';

const frame = document.getElementById('frame')!;
const canvas = document.getElementById('stage') as HTMLCanvasElement;
const wall = new Wall(canvas);

let ws: WebSocket | null = null;
let connected = false;
let build = '';
let run: RunInfo | null = null;
let replayTimer = 0;
let replaying = false;
let speed = 1;
const send = (m: ClientMsg) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };

const ui = new UI(document.getElementById('ui')!, {
  connect() { if (!connected) { ui.toast('Le pont n’est pas lancé : relance « npm start ».', 'error'); return; } send({ t: 'connect' }); },
  start(niche) {
    if (!connected) { ui.toast('Le pont n’est pas lancé : voici une recherche enregistrée.'); void demo(); return; }
    stopReplay();
    director.kind = 'live';
    send({ t: 'start', niche });
  },
  stop() { if (replaying) { stopReplay(); director.home(); } else send({ t: 'stop' }); },
  demo() { void demo(); },
  replay(id) { send({ t: 'replay', id }); },
  folder() { send({ t: 'open', id: director.kind === 'demo' ? undefined : run?.id }); },
  fresh() { stopReplay(); director.home(); },
  explore() { director.explore(); },
  leave() { director.leave(); },
  goTo(code) { director.goTo(code); },
});
const director = new Director(wall, ui);

function fit() { wall.resize(frame.clientWidth, frame.clientHeight); }
function toggleTall() { frame.classList.toggle('tall'); document.body.classList.toggle('is-tall', frame.classList.contains('tall')); fit(); }
function setSpeed(n: number) { speed = n; wall.speed = n; ui.toast(`Vitesse × ${n}`); }

// ── rejouer une recherche enregistrée ──
function stopReplay() { clearTimeout(replayTimer); replaying = false; }
function play(events: Logged[], kind: 'replay' | 'demo') {
  stopReplay();
  replaying = true;
  director.kind = kind;
  let i = 0;
  const step = () => {
    if (!replaying) return;
    const cur = events[i++];
    director.feed(cur.ev);
    if (i >= events.length) { replaying = false; return; }
    // les temps morts sont raccourcis : c'est la mise en scène qui donne le rythme
    const gap = Math.min(cur.ev.k === 'typing' ? 120 : 1100, Math.max(0, events[i].at - cur.at)) / speed;
    replayTimer = window.setTimeout(step, gap);
  };
  step();
}
async function demo() {
  try {
    const r = await fetch('/demo/recherche.json');
    const d = (await r.json()) as { run: RunInfo; log: Logged[] };
    run = null;
    play(d.log, 'demo');
  } catch {
    ui.toast('La démo est introuvable.', 'error');
  }
}

// ── la connexion au pont ──
function connect() {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  let opened = false;
  try { ws = new WebSocket(url); } catch { offline(); return; }
  ws.onopen = () => { opened = true; connected = true; };
  ws.onmessage = (e) => { let m: ServerMsg; try { m = JSON.parse(String(e.data)); } catch { return; } onServer(m); };
  ws.onclose = () => {
    const was = connected; connected = false;
    if (!opened || was) offline();
    setTimeout(connect, 2500);
  };
  ws.onerror = () => { /* « close » suit */ };
}
function offline() { ui.setClaude(null); ui.setIg({ state: 'off', message: 'Le pont n’est pas lancé.' }); }

function onServer(m: ServerMsg) {
  switch (m.t) {
    case 'hello':
      if (build && m.build && m.build !== build && m.build !== 'dev') { location.reload(); return; }
      build = m.build ?? '';
      ui.setClaude(m.claude); ui.setIg(m.ig); ui.setRuns(m.runs);
      if (m.current && m.current.run.status === 'running' && !director.active) {
        // une recherche tourne déjà (onglet rouvert) : on la reprend depuis le début, le direct suit
        run = m.current.run;
        director.kind = 'live';
        for (const l of m.current.log) director.feed(l.ev);
      }
      break;
    case 'ig': ui.setIg(m.ig); break;
    case 'run': run = m.run; break;
    case 'ev':
      if (m.ev.k === 'open') { stopReplay(); director.kind = 'live'; }
      if (replaying) break;
      director.feed(m.ev);
      break;
    case 'replay': run = m.run; play(m.log, 'replay'); break;
    case 'toast': ui.toast(m.text, m.kind); break;
  }
}

// ── le clavier (pour filmer) ──
window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
  const k = e.key.toLowerCase();
  if (k === 'f') document.body.classList.toggle('cine');
  else if (k === 'h') document.body.classList.toggle('bare');
  else if (k === 'v') toggleTall();
  else if (k === '1' || k === '2' || k === '4') setSpeed(Number(k));
  else if (k === 'd' && !director.active) void demo();
  else if (k === 'escape') { if (ui.reportOpen) ui.closeReport(); else if (wall.exploring) director.leave(); else ui.closeHistory(); }
  else if (wall.exploring && (k === 'arrowleft' || k === 'arrowright' || k === 'arrowup' || k === 'arrowdown')) { e.preventDefault(); wall.nudge(k === 'arrowleft' ? -1 : k === 'arrowright' ? 1 : 0, k === 'arrowup' ? 1 : k === 'arrowdown' ? -1 : 0); }
  else if (wall.exploring && (k === '+' || k === '=' || k === '-')) wall.nudge(0, 0, k === '-' ? 1 : -1);
});
frame.addEventListener('pointermove', (e) => {
  const r = frame.getBoundingClientRect();
  wall.setPointer(((e.clientX - r.left) / r.width) * 2 - 1, -(((e.clientY - r.top) / r.height) * 2 - 1));
});
new ResizeObserver(fit).observe(frame);
fit();
director.home();
connect();
fetch('/demo/recherche.json', { method: 'HEAD' }).then((r) => ui.setDemo(r.ok)).catch(() => ui.setDemo(false));

// pour filmer ou déboguer depuis la console : mur.demo(), mur.wall…
(window as any).mur = { wall, ui, director, demo, play };
