// Le mur : une ligne par compte, une case par reel (au format 9:16), avec sa vraie miniature et ses vues.
// L'agent passe devant chaque reel, un faisceau le lit, la case se retourne. Quand le compte est fini,
// les reels qui ont fait au moins trois fois sa médiane s'allument en orange et sortent du mur.
// Tout est dessiné en code (aucun fichier 3D), sans ombres ni post-traitement, pour ne pas chauffer un portable.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Agent } from './agent.ts';
import { BREAKOUT_MIN, BREAKOUT_X, RECENT_MS } from '../../shared/protocol.ts';
import { canvasTexture, damp, ease, easeBack, easeOut, glow, lerp, rng } from './kit.ts';

export { BREAKOUT_MIN, BREAKOUT_X };

export const COLS = 18;
export const ROWS = 12;
/** Jusqu'à 17 comptes en plus de la ligne de la recherche Instagram : les lignes au-delà de ROWS restent cachées
 * et apparaissent sous le mur quand un compte en a besoin (l'accueil garde son mur de 12 lignes). */
const MAX_ROWS = 18;
const TW = 0.9;
const TH = 1.6;
const GAP = 0.16;
const PX = TW + GAP;
const PY = TH + GAP;
const TEX_W = 200;
const TEX_H = 356;
const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Inter", "Segoe UI", system-ui, sans-serif';

export const fmtViews = (n: number | null | undefined) => {
  if (n == null) return '';
  if (n >= 1e6) return `${(n / 1e6).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} M`;
  if (n >= 1e4) return `${Math.round(n / 1e3).toLocaleString('fr-FR')} k`;
  if (n >= 1e3) return `${(n / 1e3).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} k`;
  return Math.round(n).toLocaleString('fr-FR');
};
export const fmtX = (x: number) => x.toLocaleString('fr-FR', { maximumFractionDigits: x < 10 ? 1 : 0 });

const colX = (c: number) => (c - (COLS - 1) / 2) * PX;
const rowY = (r: number) => ((ROWS - 1) / 2 - r) * PY;

type TileState = 'empty' | 'shown' | 'hit' | 'star';

interface Tile {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  canvas: HTMLCanvasElement | null;
  tex: THREE.CanvasTexture | null;
  row: number;
  col: number;
  code: string | null;
  views: number | null;
  /** une publication de la recherche Instagram : ses likes (ses vues ne s'affichent pas) */
  likes: number | null;
  takenAt: number;
  img: HTMLImageElement | null;
  state: TileState;
  multiple: number;
  flip: number;
  flipping: boolean;
  pop: number;
  popTarget: number;
  dim: number;
  dimTarget: number;
  halo: THREE.Sprite | null;
  /** la fin : la case quitte le mur pour l'éventail */
  fan: { from: THREE.Vector3; to: THREE.Vector3; q0: THREE.Quaternion; q1: THREE.Quaternion; t: number; delay: number; s0: number; s1: number; back?: boolean } | null;
  /** survolée ou choisie pendant l'exploration */
  hover: number;
}

interface Row { handle: string; title?: string; note?: string; label: THREE.Mesh; labelTex: THREE.CanvasTexture; followers: number | null; median: number | null; fade: number; tiles: Tile[]; next: number }

type Action =
  | { k: 'move'; row: number; t: number; dur: number }
  | { k: 'reveal'; tile: Tile; t: number; dur: number }
  | { k: 'rowdone'; row: number; t: number; dur: number }
  | { k: 'spot'; tile: Tile; t: number; dur: number }
  | { k: 'finale'; codes: string[]; t: number; dur: number };

// ── les textures ──
function emptyTexture() {
  return canvasTexture(TEX_W, TEX_H, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.beginPath(); g.roundRect(2, 2, w - 4, h - 4, 16);
    const grd = g.createLinearGradient(0, 0, w, h);
    grd.addColorStop(0, '#121216'); grd.addColorStop(1, '#09090B');
    g.fillStyle = grd; g.fill();
    g.lineWidth = 2; g.strokeStyle = 'rgba(255,255,255,.075)'; g.stroke();
    // le petit signe « reel » au centre
    g.strokeStyle = 'rgba(255,255,255,.07)'; g.lineWidth = 3;
    g.beginPath(); g.roundRect(w / 2 - 22, h / 2 - 22, 44, 44, 12); g.stroke();
    g.fillStyle = 'rgba(255,255,255,.07)';
    g.beginPath(); g.moveTo(w / 2 - 6, h / 2 - 9); g.lineTo(w / 2 + 10, h / 2); g.lineTo(w / 2 - 6, h / 2 + 9); g.closePath(); g.fill();
  });
}

function drawTile(t: Tile) {
  if (!t.canvas) { t.canvas = document.createElement('canvas'); t.canvas.width = TEX_W; t.canvas.height = TEX_H; }
  const g = t.canvas.getContext('2d')!;
  const w = TEX_W, h = TEX_H;
  g.clearRect(0, 0, w, h);
  g.save();
  g.beginPath(); g.roundRect(2, 2, w - 4, h - 4, 16); g.clip();
  g.fillStyle = '#0D0D10'; g.fillRect(0, 0, w, h);
  const img = t.img;
  if (img && img.naturalWidth) {
    const s = Math.max(w / img.naturalWidth, h / img.naturalHeight);
    const iw = img.naturalWidth * s, ih = img.naturalHeight * s;
    g.drawImage(img, (w - iw) / 2, (h - ih) / 2, iw, ih);
  } else {
    const grd = g.createLinearGradient(0, 0, 0, h);
    grd.addColorStop(0, '#1A1A20'); grd.addColorStop(1, '#0B0B0E');
    g.fillStyle = grd; g.fillRect(0, 0, w, h);
  }
  const shade = g.createLinearGradient(0, h * 0.55, 0, h);
  shade.addColorStop(0, 'rgba(0,0,0,0)'); shade.addColorStop(1, 'rgba(0,0,0,.82)');
  g.fillStyle = shade; g.fillRect(0, h * 0.5, w, h * 0.5);
  // les likes d'une publication de la recherche Instagram
  if (t.views == null && t.likes != null) {
    g.fillStyle = '#FFFFFF';
    const hx = 25, hy = h - 34;
    g.beginPath(); g.moveTo(hx, hy + 9);
    g.bezierCurveTo(hx - 13, hy, hx - 9, hy - 11, hx, hy - 4);
    g.bezierCurveTo(hx + 9, hy - 11, hx + 13, hy, hx, hy + 9);
    g.fill();
    g.font = `800 31px ${FONT}`;
    g.fillText(fmtViews(t.likes), 44, h - 21);
  }
  // les vues, comme sur la grille d'Instagram
  if (t.views != null) {
    const hot = t.state === 'hit' || t.state === 'star';
    g.fillStyle = hot ? '#FFB070' : '#FFFFFF';
    g.beginPath(); g.moveTo(16, h - 44); g.lineTo(34, h - 33); g.lineTo(16, h - 22); g.closePath(); g.fill();
    g.font = `800 ${hot ? 34 : 31}px ${FONT}`;
    g.textBaseline = 'alphabetic';
    g.fillText(fmtViews(t.views), 42, h - 21);
  }
  g.restore();
  if (t.state === 'hit' || t.state === 'star') {
    g.lineWidth = t.state === 'star' ? 8 : 6;
    g.strokeStyle = '#FF8A3D';
    g.beginPath(); g.roundRect(4, 4, w - 8, h - 8, 15); g.stroke();
    // le badge « ×15 »
    const label = `×${fmtX(t.multiple)}`;
    g.font = `900 36px ${FONT}`;
    const bw = g.measureText(label).width + 26;
    g.fillStyle = '#FF8A3D';
    g.beginPath(); g.roundRect(w - bw - 12, 14, bw, 50, 25); g.fill();
    g.fillStyle = '#160A02';
    g.fillText(label, w - bw + 1, 52);
  }
  if (!t.tex) { t.tex = new THREE.CanvasTexture(t.canvas); t.tex.colorSpace = THREE.SRGBColorSpace; t.tex.anisotropy = 4; }
  t.tex.needsUpdate = true;
}

function drawLabel(row: Row) {
  const c = row.labelTex.image as HTMLCanvasElement;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, c.width, c.height);
  g.textAlign = 'right';
  g.fillStyle = '#F5F5F7';
  g.font = `800 52px ${FONT}`;
  let name = row.title ?? `@${row.handle}`;
  while (g.measureText(name).width > c.width - 20 && name.length > 6) name = name.slice(0, -2) + '…';
  g.fillText(name, c.width - 10, 70);
  const bits: string[] = [];
  if (row.title) bits.push('recherche Instagram');
  if (row.followers != null) bits.push(`${fmtViews(row.followers)} abonnés`);
  if (row.median != null) bits.push(`médiane ${fmtViews(row.median)}`);
  g.font = `600 34px ${FONT}`;
  g.fillStyle = row.median != null ? '#FFB070' : '#A1A1A6';
  g.fillText(bits.join(' · ') || (row.note ? `sauté · ${row.note}` : 'lecture…'), c.width - 10, 124);
  row.labelTex.needsUpdate = true;
}

export interface WallHooks {
  /** une case vient d'être lue (avec des vues) */
  onRead?: (code: string) => void;
  /** des reels ont passé trois fois la médiane de leur compte */
  onHits?: (codes: string[]) => void;
  /** tout ce qui était en attente est joué */
  onIdle?: () => void;
  /** exploration : une case choisie (ou rien), et où le clic a eu lieu sur l'écran */
  onPick?: (code: string | null, at: { x: number; y: number }) => void;
}

export class Wall {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(36, 16 / 9, 0.1, 400);
  agent = new Agent();
  /** 1, 2, 4 : la vitesse de la mise en scène */
  speed = 1;
  hooks: WallHooks = {};
  private tiles: Tile[] = [];
  private byCode = new Map<string, Tile>();
  /** les cases de la ligne « recherche Instagram » dont le reel a aussi sa case dans la ligne de son compte */
  private kwTiles = new Map<string, Tile>();
  private rows: Row[] = [];
  private rowOf = new Map<string, number>();
  private queue: Action[] = [];
  private act: Action | null = null;
  private empty = emptyTexture();
  private beam: THREE.Mesh;
  private scan: THREE.Mesh;
  private spotGlow: THREE.Sprite;
  private dust: THREE.Points;
  private camPos = new THREE.Vector3(16, 3, 30);
  private camLook = new THREE.Vector3(-2, 0, 0);
  private wantPos = new THREE.Vector3(16, 3, 30);
  private wantLook = new THREE.Vector3(-2, 0, 0);
  private camLambda = 1.2;
  private mode: 'home' | 'follow' | 'focus' | 'overview' | 'fan' | 'explore' = 'home';
  // l'exploration libre du mur, à la fin
  private ex = { target: new THREE.Vector3(), dist: 24, yaw: 0, pitch: 0, wantTarget: new THREE.Vector3(), wantDist: 24, wantYaw: 0, wantPitch: 0 };
  private drag: { x: number; y: number; moved: number; orbit: boolean } | null = null;
  private ray = new THREE.Raycaster();
  private hovered: Tile | null = null;
  private selected: Tile | null = null;
  private canvas: HTMLCanvasElement;
  private pointer = new THREE.Vector2();
  private aspect = 16 / 9;
  private clock = new THREE.Clock();
  private time = 0;
  private reading: Tile | null = null;
  private beamOn = 0;
  private shake = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.scene.background = new THREE.Color('#040405');
    this.scene.fog = new THREE.FogExp2('#040405', 0.014);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.add(new THREE.HemisphereLight('#c9c9d6', '#0a0a0c', 0.6));
    const key = new THREE.DirectionalLight('#ffffff', 1.6); key.position.set(-4, 6, 8); this.scene.add(key);
    const rim = new THREE.PointLight('#ff8a3d', 18, 10, 2); rim.position.set(2, 1, 1.2); this.agent.root.add(rim);

    // les cases vides du mur
    for (let r = 0; r < MAX_ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const mat = new THREE.MeshBasicMaterial({ map: this.empty, transparent: true, toneMapped: false, fog: true, depthWrite: true, alphaTest: 0.02 });
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(TW, TH), mat);
        mesh.position.set(colX(c), rowY(r), 0);
        mesh.visible = r < ROWS;
        this.scene.add(mesh);
        this.tiles.push({ mesh, mat, canvas: null, tex: null, row: r, col: c, code: null, views: null, likes: null, takenAt: 0, img: null, state: 'empty', multiple: 0, flip: 0, flipping: false, pop: 0, popTarget: 0, dim: 1, dimTarget: 1, halo: null, fan: null, hover: 0 });
      }
    }

    // le faisceau de lecture : un cône de lumière des yeux de l'agent jusqu'au reel
    const beamTex = canvasTexture(8, 128, (g, w, h) => {
      const grd = g.createLinearGradient(0, 0, 0, h);
      grd.addColorStop(0, 'rgba(255,150,80,0.9)'); grd.addColorStop(0.35, 'rgba(255,138,61,0.35)'); grd.addColorStop(1, 'rgba(255,138,61,0.05)');
      g.fillStyle = grd; g.fillRect(0, 0, w, h);
    });
    const beamGeo = new THREE.CylinderGeometry(0.03, 0.62, 1, 32, 1, true);
    beamGeo.translate(0, -0.5, 0);
    beamGeo.rotateX(-Math.PI / 2); // l'axe du cône part vers -z… puis on l'oriente avec lookAt
    this.beam = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({ map: beamTex, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
    this.beam.renderOrder = 15;
    this.scene.add(this.beam);
    // la ligne qui balaie le reel pendant qu'il le lit
    this.scan = new THREE.Mesh(new THREE.PlaneGeometry(TW * 1.06, 0.07), new THREE.MeshBasicMaterial({ color: '#FFB070', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    this.scan.renderOrder = 16;
    this.scene.add(this.scan);
    this.spotGlow = glow(2.6, 0);
    this.scene.add(this.spotGlow);

    // la poussière lumineuse, pour la profondeur
    const rand = rng(7);
    const n = 520;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { pos[i * 3] = (rand() - 0.5) * 46; pos[i * 3 + 1] = (rand() - 0.5) * 30; pos[i * 3 + 2] = rand() * 22 - 3; }
    const dg = new THREE.BufferGeometry(); dg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.dust = new THREE.Points(dg, new THREE.PointsMaterial({ color: '#ff9a55', size: 0.045, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
    this.scene.add(this.dust);

    this.agent.place(new THREE.Vector3(colX(-3), rowY(0) + 1.5, 3));
    this.scene.add(this.agent.root);
    this.renderer.setAnimationLoop(() => this.frame());
    this.listen();
  }

  get exploring() { return this.mode === 'explore'; }

  /** La fin : on se promène dans le mur. Glisser pour se déplacer, molette pour zoomer, clic droit ou Maj pour tourner. */
  explore() {
    for (const t of this.tiles) {
      if (t.fan && !t.fan.back) t.fan = { from: t.mesh.position.clone(), to: new THREE.Vector3(colX(t.col), rowY(t.row), 0), q0: t.mesh.quaternion.clone(), q1: new THREE.Quaternion(), t: 0, delay: 0, s0: t.mesh.scale.x, s1: 1, back: true };
      if (t.halo && (t.state === 'hit' || t.state === 'star')) (t.halo.userData as { want: number }).want = t.state === 'star' ? 0.7 : 0.45;
    }
    this.queue = []; this.act = null; this.reading = null;
    const used = Math.max(1, this.rows.length);
    const cy = (rowY(0) + rowY(used - 1)) / 2;
    this.ex.target.copy(this.camLook);
    this.ex.dist = this.camPos.distanceTo(this.camLook);
    this.ex.yaw = 0; this.ex.pitch = 0;
    this.ex.wantTarget.set(this.aspect < 0.9 ? 0 : -1.6, cy, 0);
    this.ex.wantDist = this.aspect < 0.9 ? 30 : 23;
    this.ex.wantYaw = 0; this.ex.wantPitch = 0;
    this.mode = 'explore';
    this.agent.size = 1;
    this.canvas.style.cursor = 'grab';
  }

  /** Quitter l'exploration : la vue d'ensemble. */
  leave() {
    if (this.mode !== 'explore') return;
    this.mode = 'overview';
    this.selected = null; this.hovered = null;
    this.canvas.style.cursor = '';
    this.hooks.onPick?.(null, { x: 0, y: 0 });
  }

  /** Les flèches et + / − pendant l'exploration. */
  nudge(dx: number, dy: number, zoom = 0) {
    if (!this.exploring) return;
    const k = this.ex.wantDist * 0.06;
    this.ex.wantTarget.x += dx * k; this.ex.wantTarget.y += dy * k;
    if (zoom) this.ex.wantDist = Math.min(60, Math.max(3.5, this.ex.wantDist * Math.exp(zoom * 0.25)));
    this.clampTarget();
  }

  /** Va voir un reel (depuis l'analyse) : la caméra s'en approche et la fiche s'ouvre. */
  goTo(code: string) {
    const t = this.byCode.get(code);
    if (!t) return;
    if (!this.exploring) this.explore();
    this.selected = t;
    this.ex.wantTarget.set(t.mesh.position.x + (this.aspect < 0.9 ? 0 : 1.4), t.mesh.position.y - (this.aspect < 0.9 ? 1.2 : 0), 0);
    this.ex.wantDist = this.aspect < 0.9 ? 10 : 8;
    const r = this.canvas.getBoundingClientRect();
    this.hooks.onPick?.(code, { x: r.left + r.width * 0.5, y: r.top + r.height * 0.45 });
  }

  private clampTarget() {
    const hw = (COLS / 2) * PX + 1.5;
    const used = Math.max(1, this.rows.length);
    this.ex.wantTarget.x = Math.min(hw, Math.max(-hw, this.ex.wantTarget.x));
    this.ex.wantTarget.y = Math.min(rowY(0) + 2, Math.max(rowY(used - 1) - 3, this.ex.wantTarget.y));
  }

  private pickAt(clientX: number, clientY: number): Tile | null {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    const meshes = this.tiles.filter((t) => t.code && t.state !== 'empty').map((t) => t.mesh);
    const hit = this.ray.intersectObjects(meshes, false)[0];
    return hit ? this.tiles.find((t) => t.mesh === hit.object) ?? null : null;
  }

  private listen() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      if (!this.exploring) return;
      this.drag = { x: e.clientX, y: e.clientY, moved: 0, orbit: e.button === 2 || e.shiftKey };
      try { c.setPointerCapture(e.pointerId); } catch { /* pas grave */ }
      c.style.cursor = 'grabbing';
    });
    c.addEventListener('pointermove', (e) => {
      if (!this.exploring) return;
      if (this.drag) {
        const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
        this.drag.x = e.clientX; this.drag.y = e.clientY; this.drag.moved += Math.abs(dx) + Math.abs(dy);
        if (this.drag.orbit) {
          this.ex.wantYaw = Math.min(0.75, Math.max(-0.75, this.ex.wantYaw - dx * 0.004));
          this.ex.wantPitch = Math.min(0.45, Math.max(-0.45, this.ex.wantPitch + dy * 0.003));
        } else {
          const k = (this.ex.wantDist * 1.05) / Math.max(400, c.clientHeight);
          this.ex.wantTarget.x -= dx * k; this.ex.wantTarget.y += dy * k;
          this.clampTarget();
        }
      } else {
        const t = this.pickAt(e.clientX, e.clientY);
        if (t !== this.hovered) { this.hovered = t; c.style.cursor = t ? 'pointer' : 'grab'; }
      }
    });
    const up = (e: PointerEvent) => {
      if (!this.exploring || !this.drag) return;
      const click = this.drag.moved < 6;
      this.drag = null;
      c.style.cursor = this.hovered ? 'pointer' : 'grab';
      if (!click) return;
      const t = this.pickAt(e.clientX, e.clientY);
      this.selected = t;
      this.hooks.onPick?.(t?.code ?? null, { x: e.clientX, y: e.clientY });
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', () => { this.drag = null; });
    c.addEventListener('wheel', (e) => {
      if (!this.exploring) return;
      e.preventDefault();
      this.ex.wantDist = Math.min(60, Math.max(3.5, this.ex.wantDist * Math.exp(e.deltaY * 0.0013)));
    }, { passive: false });
    c.addEventListener('contextmenu', (e) => { if (this.exploring) e.preventDefault(); });
  }

  resize(w: number, h: number) {
    this.aspect = w / Math.max(1, h);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = this.aspect;
    this.camera.fov = this.aspect < 0.9 ? 52 : 36;
    this.camera.updateProjectionMatrix();
    if (this.mode === 'home') this.home();
  }

  setPointer(x: number, y: number) { this.pointer.set(x, y); }

  /** Le mur vide, vu de trois quarts : l'écran d'accueil. */
  home() {
    this.mode = 'home';
    this.agent.size = this.aspect < 0.9 ? 1.9 : 2.3;
    this.camLambda = 1.1;
    if (this.aspect < 0.9) { this.wantPos.set(7, 1, 34); this.wantLook.set(-1, 0, 0); }
    else { this.wantPos.set(17, 2.5, 27); this.wantLook.set(-3.5, -0.5, 0); }
    this.agent.target.set(colX(4), rowY(2) + 0.5, 3.4);
    this.agent.look.set(colX(6), rowY(3), 0);
  }

  /** Une nouvelle recherche : le mur se vide. */
  reset() {
    this.queue = []; this.act = null; this.reading = null;
    for (const t of this.tiles) {
      t.code = null; t.views = null; t.likes = null; t.takenAt = 0; t.img = null; t.hover = 0; t.state = 'empty'; t.multiple = 0; t.flip = 0; t.flipping = false;
      t.pop = t.popTarget = 0; t.dim = t.dimTarget = 1; t.fan = null;
      t.mat.map = this.empty; t.mat.color.setScalar(1); t.mat.needsUpdate = true;
      t.mesh.position.set(colX(t.col), rowY(t.row), 0); t.mesh.quaternion.identity(); t.mesh.scale.setScalar(1);
      t.mesh.visible = t.row < ROWS;
      if (t.halo) { this.scene.remove(t.halo); t.halo = null; }
      t.tex?.dispose(); t.tex = null; t.canvas = null;
    }
    for (const r of this.rows) { this.scene.remove(r.label); r.labelTex.dispose(); }
    this.rows = []; this.rowOf.clear(); this.byCode.clear(); this.kwTiles.clear();
    this.finaleStarted = false;
    this.home();
  }

  get busy() { return !!this.act || this.queue.length > 0; }

  /** La ligne d'un compte (créée à son premier reel). */
  private rowFor(handle: string): Row | null {
    const have = this.rowOf.get(handle);
    if (have != null) return this.rows[have];
    if (this.rows.length >= MAX_ROWS) return null;
    const r = this.rows.length;
    const labelTex = canvasTexture(720, 150, () => {});
    const label = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 0.75), new THREE.MeshBasicMaterial({ map: labelTex, transparent: true, opacity: 0, toneMapped: false, depthWrite: false }));
    label.position.set(colX(0) - TW / 2 - 0.25 - 1.8, rowY(r) + 0.1, 0);
    this.scene.add(label);
    const row: Row = { handle, label, labelTex, followers: null, median: null, fade: 0, tiles: this.tiles.filter((t) => t.row === r), next: 0 };
    for (const t of row.tiles) t.mesh.visible = true;
    drawLabel(row);
    this.rows.push(row);
    this.rowOf.set(handle, r);
    this.queue.push({ k: 'move', row: r, t: 0, dur: 1.1 });
    return row;
  }

  setRowInfo(handle: string, info: { followers?: number | null; median?: number | null; note?: string }) {
    const r = this.rowOf.get(handle);
    if (r == null) return;
    const row = this.rows[r];
    if (info.followers !== undefined) row.followers = info.followers;
    if (info.median !== undefined) row.median = info.median;
    if (info.note !== undefined) row.note = info.note;
    drawLabel(row);
  }

  /** Des reels lus sur la grille d'un compte : ils se retournent un par un. */
  addReels(handle: string, reels: { code: string; views: number | null; thumb: string | null; takenAt?: number }[]) {
    const row = this.rowFor(handle);
    if (!row) return;
    for (const r of reels) {
      const known = this.byCode.get(r.code);
      const inSearch = known != null && this.rows[known.row]?.handle === '#kw';
      if (known && !inSearch) { if (known.views == null && r.views != null) { known.views = r.views; if (known.state !== 'empty') drawTile(known); } continue; }
      if (known && inSearch) this.kwTiles.set(r.code, known);
      if (row.next >= COLS) continue;
      const tile = row.tiles[row.next++];
      tile.code = r.code; tile.views = r.views; tile.takenAt = r.takenAt ?? 0;
      this.byCode.set(r.code, tile);
      if (r.thumb) this.setThumb(r.code, r.thumb);
      this.queue.push({ k: 'reveal', tile, t: 0, dur: 0.24 });
    }
  }

  /** Les publications que la recherche Instagram sort en premier : la première ligne du mur. */
  addPosts(label: string, posts: { code: string; likes: number | null; thumb: string | null; takenAt: number }[]) {
    const row = this.rowFor('#kw');
    if (!row) return;
    if (row.title !== label) { row.title = label; drawLabel(row); }
    for (const p of posts) {
      if (this.byCode.has(p.code) || row.next >= COLS) continue;
      const tile = row.tiles[row.next++];
      tile.code = p.code; tile.likes = p.likes; tile.takenAt = p.takenAt;
      this.byCode.set(p.code, tile);
      if (p.thumb) this.setThumb(p.code, p.thumb);
      this.queue.push({ k: 'reveal', tile, t: 0, dur: 0.3 });
    }
  }

  setThumb(code: string, url: string) {
    const kw = this.kwTiles.get(code);
    if (kw && !kw.img) this.setThumbOn(kw, url);
    const t = this.byCode.get(code);
    if (t && !t.img) this.setThumbOn(t, url);
  }

  private setThumbOn(t: Tile, url: string) {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => { t.img = img; if (t.state !== 'empty') drawTile(t); };
    img.src = url;
  }

  /** Le compte est lu : sa médiane, et ses reels qui ont explosé. */
  rowDone(handle: string, median: number | null) {
    const r = this.rowOf.get(handle);
    if (r == null) return;
    this.rows[r].median = median;
    this.queue.push({ k: 'rowdone', row: r, t: 0, dur: 0.9 });
  }

  /** Un reel qui a explosé, ouvert par l'agent : gros plan. */
  spotlight(code: string, multiple: number) {
    const t = this.byCode.get(code);
    if (!t) return;
    t.multiple = multiple;
    this.queue.push({ k: 'spot', tile: t, t: 0, dur: 2.1 });
  }

  /** La fin : le mur entier, puis les plus gros reels qui sortent en éventail. */
  finale(codes: string[]) { this.queue.push({ k: 'finale', codes, t: 0, dur: 99999 }); }

  /** Les cases d'une ligne qui passent trois fois la médiane. */
  private hitsOf(row: Row): Tile[] {
    const m = row.median ?? 0;
    const now = Date.now();
    return row.tiles.filter((t) => t.code && t.views != null && m > 0 && t.views / m >= BREAKOUT_X && t.views >= BREAKOUT_MIN && (!t.takenAt || now - t.takenAt < RECENT_MS));
  }

  // ── la boucle ──
  private frame() {
    const dt = Math.min(0.05, this.clock.getDelta());
    this.time += dt;
    this.step(dt * this.speed);
    this.animate(dt);
    this.renderer.render(this.scene, this.camera);
  }

  private start(a: Action) {
    this.act = a;
    if (a.k === 'move') {
      this.mode = 'follow';
      this.agent.size = 1;
      const row = this.rows[a.row];
      row.fade = 0;
    } else if (a.k === 'reveal') {
      this.reading = a.tile;
      this.beamOn = 1;
    } else if (a.k === 'rowdone') {
      const row = this.rows[a.row];
      drawLabel(row);
      const hits = this.hitsOf(row);
      for (const t of row.tiles) {
        if (!t.code) continue;
        if (hits.includes(t)) { t.state = 'hit'; t.multiple = row.median ? t.views! / row.median : 0; t.popTarget = 0.28; drawTile(t); this.addHalo(t, 0.45); }
        else t.dimTarget = 0.42;
      }
      if (hits.length) { this.agent.surprise(); this.hooks.onHits?.(hits.map((t) => t.code!)); }
      this.reading = null;
    } else if (a.k === 'spot') {
      const t = a.tile;
      this.mode = 'focus';
      this.camLambda = 2.6;
      t.state = 'star'; t.popTarget = 0.55; t.dimTarget = 1; drawTile(t);
      this.addHalo(t, 0.85);
      this.agent.surprise();
      this.shake = 0.5;
      this.reading = null;
    } else if (a.k === 'finale') {
      this.reading = null;
      this.mode = 'overview';
      this.camLambda = 1.4;
    }
  }

  private finish(a: Action) {
    if (a.k === 'reveal') {
      const t = a.tile;
      if (t.views != null) this.hooks.onRead?.(t.code!);
    } else if (a.k === 'spot') this.mode = 'follow';
    this.act = null;
  }

  private step(dt: number) {
    if (!this.act) {
      const next = this.queue.shift();
      if (!next) { if (this.beamOn > 0) this.beamOn = Math.max(0, this.beamOn - dt * 3); return; }
      this.start(next);
    }
    const a = this.act!;
    // s'il reste beaucoup à jouer (le relevé va plus vite que la mise en scène), on accélère un peu
    const rush = a.k === 'reveal' ? Math.min(3, 1 + this.queue.filter((q) => q.k === 'reveal').length / 14) : 1;
    a.t += dt * rush;
    const k = Math.min(1, a.t / a.dur);
    if (a.k === 'reveal') {
      const t = a.tile;
      if (!t.flipping && k > 0.25) { t.flipping = true; t.flip = 0; }
    } else if (a.k === 'finale') {
      this.runFinale(a);
    }
    if (k >= 1 && a.k !== 'finale') this.finish(a);
  }

  private addHalo(t: Tile, opacity: number) {
    if (!t.halo) {
      t.halo = glow(2.8, 0);
      t.halo.position.set(t.mesh.position.x, t.mesh.position.y, -0.05);
      t.halo.renderOrder = 2;
      this.scene.add(t.halo);
    }
    (t.halo.userData as { want: number }).want = opacity;
  }

  private finaleStarted = false;
  private runFinale(a: Extract<Action, { k: 'finale' }>) {
    // 0 → 2,6 s : le mur entier ; ensuite, l'éventail des plus gros reels
    if (a.t < 2.6 || this.finaleStarted) return;
    this.finaleStarted = true;
    this.mode = 'fan';
    const tiles = a.codes.map((c) => this.byCode.get(c)).filter((t): t is Tile => !!t).slice(0, this.aspect < 0.9 ? 3 : 5);
    const n = tiles.length;
    if (!n) return;
    // l'éventail se pose devant la caméra de la vue d'ensemble
    const camPos = this.wantPos.clone();
    const fwd = new THREE.Vector3().subVectors(this.wantLook, camPos).normalize();
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
    const dist = this.aspect < 0.9 ? 15 : 14;
    const center = camPos.clone().addScaledVector(fwd, dist).addScaledVector(up, this.aspect < 0.9 ? 4.1 : 0.5).addScaledVector(right, this.aspect < 0.9 ? 0 : -2.2);
    const spacing = this.aspect < 0.9 ? 2.2 : 2.05;
    const look = new THREE.Matrix4();
    tiles.forEach((t, i) => {
      const off = i - (n - 1) / 2;
      const to = center.clone().addScaledVector(right, off * spacing).addScaledVector(fwd, Math.abs(off) * 0.5).addScaledVector(up, -Math.abs(off) * 0.12);
      look.lookAt(camPos, to, up);
      const q1 = new THREE.Quaternion().setFromRotationMatrix(look);
      q1.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -off * 0.06));
      t.fan = { from: t.mesh.position.clone(), to, q0: t.mesh.quaternion.clone(), q1, t: 0, delay: i * 0.14, s0: 1, s1: this.aspect < 0.9 ? 1.7 : 1.62 };
      t.state = 'star'; t.dimTarget = 1; drawTile(t);
      if (t.halo) (t.halo.userData as { want: number }).want = 0;
    });
  }

  private animate(dt: number) {
    const sp = this.speed;
    // la caméra
    const a = this.act;
    const tile = this.reading ?? (a && (a.k === 'spot' || a.k === 'reveal') ? a.tile : null);
    if (this.mode === 'follow' || (this.mode === 'focus' && a?.k !== 'spot')) {
      const row = a?.k === 'move' ? this.rows[a.row] : tile ? this.rows[tile.row] : this.rows[this.rows.length - 1];
      const col = tile ? tile.col : a?.k === 'move' ? 0 : row ? Math.max(0, row.next - 1) : 0;
      const r = tile ? tile.row : row ? this.rowOf.get(row.handle)! : 0;
      const x = colX(col), y = rowY(r);
      this.agent.target.set(x - 0.55, y + 0.95, 1.55);
      this.agent.look.set(x, y, 0);
      if (this.aspect < 0.9) { this.wantPos.set(x - 1.5, y + 0.3, 11); this.wantLook.set(x + 1.0, y - 0.5, 0); }
      else { this.wantPos.set(x - 4.6, y + 0.5, 12.8); this.wantLook.set(x + 2.3, y - 0.25, 0); }
      this.camLambda = a?.k === 'move' ? 1.9 : 2.3;
    } else if (this.mode === 'focus' && a?.k === 'spot') {
      const t = a.tile;
      const x = t.mesh.position.x, y = t.mesh.position.y;
      this.agent.target.set(x - 0.9, y + 1.05, 1.9);
      this.agent.look.set(x, y, 0.5);
      if (this.aspect < 0.9) { this.wantPos.set(x - 0.5, y + 0.35, 7.6); this.wantLook.set(x + 0.1, y + 0.2, 0); }
      else { this.wantPos.set(x - 1.7, y + 0.45, 7.2); this.wantLook.set(x + 0.35, y + 0.15, 0); }
    } else if (this.mode === 'overview' || this.mode === 'fan') {
      const used = Math.max(1, this.rows.length);
      const cy = (rowY(0) + rowY(used - 1)) / 2;
      if (this.aspect < 0.9) { this.wantPos.set(0, cy - 1, 44 + Math.max(0, used - ROWS) * 1.8); this.wantLook.set(0, cy, 0); }
      else { this.wantPos.set(0, cy - 0.8, 26 + used * 1.05); this.wantLook.set(0, cy - 0.3, 0); }
      this.agent.target.set(colX(COLS - 1) + 1.6, cy + 1.2, 3);
      this.agent.look.set(0, cy, 0);
    } else if (this.mode === 'explore') {
      const e = this.ex;
      e.target.x = damp(e.target.x, e.wantTarget.x, 7, dt);
      e.target.y = damp(e.target.y, e.wantTarget.y, 7, dt);
      e.dist = damp(e.dist, e.wantDist, 7, dt);
      e.yaw = damp(e.yaw, e.wantYaw, 7, dt);
      e.pitch = damp(e.pitch, e.wantPitch, 7, dt);
      this.wantLook.set(e.target.x, e.target.y, 0);
      this.wantPos.set(e.target.x + Math.sin(e.yaw) * Math.cos(e.pitch) * e.dist, e.target.y + Math.sin(e.pitch) * e.dist, Math.cos(e.yaw) * Math.cos(e.pitch) * e.dist);
      this.camLambda = 9;
      this.agent.target.set(e.target.x - Math.min(6, e.dist * 0.28), e.target.y + Math.min(4, e.dist * 0.16), Math.min(5, e.dist * 0.3));
      this.agent.look.copy(this.selected ? this.selected.mesh.position : this.camera.position);
    } else if (this.mode === 'home') {
      // l'écran d'accueil : la caméra dérive doucement
      const s = Math.sin(this.time * 0.12);
      this.wantLook.x += (this.aspect < 0.9 ? -1 : -3.5 + s * 0.6) - this.wantLook.x;
      const ax = this.aspect < 0.9 ? colX(9) : colX(10);
      this.agent.target.set(ax + Math.sin(this.time * 0.45) * 0.9, rowY(this.aspect < 0.9 ? 3 : 4) + 0.3 + Math.sin(this.time * 0.8) * 0.35, 4.6);
      // il te regarde, et jette parfois un œil au mur
      const glance = Math.sin(this.time * 0.37) > 0.6;
      if (glance) this.agent.look.set(colX(4), rowY(5), 0); else this.agent.look.copy(this.camera.position);
    }
    const lam = this.camLambda;
    this.camPos.x = damp(this.camPos.x, this.wantPos.x, lam, dt);
    this.camPos.y = damp(this.camPos.y, this.wantPos.y, lam, dt);
    this.camPos.z = damp(this.camPos.z, this.wantPos.z, lam, dt);
    this.camLook.x = damp(this.camLook.x, this.wantLook.x, lam, dt);
    this.camLook.y = damp(this.camLook.y, this.wantLook.y, lam, dt);
    this.camLook.z = damp(this.camLook.z, this.wantLook.z, lam, dt);
    this.shake = Math.max(0, this.shake - dt * 1.6);
    const sh = this.shake * this.shake * 0.08;
    const par = this.exploring ? 0 : 1;
    this.camera.position.set(this.camPos.x + this.pointer.x * 0.35 * par + Math.sin(this.time * 41) * sh, this.camPos.y + this.pointer.y * 0.22 * par + Math.cos(this.time * 37) * sh, this.camPos.z);
    this.camera.lookAt(this.camLook);

    // l'agent, son faisceau, la ligne qui balaie
    this.agent.update(dt * Math.min(2, sp));
    const reading = this.reading;
    const beamMat = this.beam.material as THREE.MeshBasicMaterial;
    const scanMat = this.scan.material as THREE.MeshBasicMaterial;
    if (reading && this.beamOn > 0) {
      const eye = this.agent.eyesWorld();
      const to = reading.mesh.position.clone(); to.z += 0.02;
      const len = eye.distanceTo(to);
      this.beam.position.copy(eye);
      this.beam.lookAt(to);
      this.beam.scale.set(1, 1, len);
      beamMat.opacity = damp(beamMat.opacity, 0.32, 14, dt);
      const ra = this.act?.k === 'reveal' ? Math.min(1, this.act.t / this.act.dur) : 1;
      this.scan.position.set(to.x, to.y + TH / 2 - ra * TH, 0.03);
      scanMat.opacity = damp(scanMat.opacity, ra < 1 ? 0.85 : 0, 18, dt);
      this.spotGlow.position.set(to.x, to.y, 0.1);
      (this.spotGlow.material as THREE.SpriteMaterial).opacity = damp((this.spotGlow.material as THREE.SpriteMaterial).opacity, 0.32, 10, dt);
    } else {
      beamMat.opacity = damp(beamMat.opacity, 0, 8, dt);
      scanMat.opacity = damp(scanMat.opacity, 0, 10, dt);
      (this.spotGlow.material as THREE.SpriteMaterial).opacity = damp((this.spotGlow.material as THREE.SpriteMaterial).opacity, 0, 6, dt);
    }

    // les cases
    for (const t of this.tiles) {
      if (t.flipping) {
        t.flip = Math.min(1, t.flip + dt * sp * 3.4);
        const k = t.flip;
        if (k >= 0.5 && t.mat.map !== t.tex) {
          if (t.state === 'empty') t.state = 'shown';
          drawTile(t); t.mat.map = t.tex; t.mat.needsUpdate = true;
        }
        const ang = k < 0.5 ? ease(k * 2) * (Math.PI / 2) : -(1 - easeBack(Math.min(1, (k - 0.5) * 2))) * (Math.PI / 2);
        t.mesh.rotation.y = ang;
        if (k >= 1) { t.flipping = false; t.mesh.rotation.y = 0; }
      }
      if (t.fan) {
        const f = t.fan;
        f.t += dt;
        const k = easeOut(Math.min(1, Math.max(0, (f.t - f.delay) / (f.back ? 0.9 : 1.25))));
        t.mesh.position.lerpVectors(f.from, f.to, k);
        if (!f.back) t.mesh.position.y += Math.sin(k * Math.PI) * 1.2;
        t.mesh.quaternion.slerpQuaternions(f.q0, f.q1, k);
        t.mesh.scale.setScalar(lerp(f.s0, f.s1, k));
        t.mat.color.setScalar(1);
        if (f.back && k >= 1) { t.fan = null; t.mesh.quaternion.identity(); t.mesh.position.set(colX(t.col), rowY(t.row), 0); }
        continue;
      }
      t.pop = damp(t.pop, t.popTarget, 6, dt);
      t.hover = damp(t.hover, this.exploring && (t === this.hovered || t === this.selected) ? (t === this.selected ? 1 : 0.6) : 0, 10, dt);
      t.mesh.position.z = t.pop + t.hover * 0.35 + (t.state === 'star' ? Math.sin(this.time * 2 + t.col) * 0.04 : 0);
      t.mesh.scale.setScalar(1 + t.pop * 0.22 + t.hover * 0.14);
      t.dim = damp(t.dim, t.dimTarget, 3, dt);
      if (t.state === 'empty') {
        // le mur vide respire : une vague lente passe sur les cases
        const w = 0.6 + 0.4 * Math.max(0, Math.sin(this.time * 0.9 - t.col * 0.35 - t.row * 0.2));
        t.mat.color.setScalar(this.rows.length ? 0.55 + 0.25 * w : 0.7 + 0.3 * w);
      } else t.mat.color.setScalar(this.exploring ? Math.max(t.dim, 0.7) + t.hover * 0.3 : t.dim);
      if (t.halo) {
        const want = (t.halo.userData as { want?: number }).want ?? 0;
        const m = t.halo.material as THREE.SpriteMaterial;
        m.opacity = damp(m.opacity, want * (0.85 + Math.sin(this.time * 3 + t.col) * 0.15), 5, dt);
        t.halo.position.set(t.mesh.position.x, t.mesh.position.y, t.mesh.position.z - 0.08);
      }
    }
    // les étiquettes des comptes
    for (const r of this.rows) {
      r.fade = Math.min(1, r.fade + dt * 1.5);
      (r.label.material as THREE.MeshBasicMaterial).opacity = r.fade;
    }
    this.dust.rotation.y = Math.sin(this.time * 0.05) * 0.05;
    (this.dust.material as THREE.PointsMaterial).opacity = 0.35 + Math.sin(this.time * 0.7) * 0.1;
    if (!this.busy) this.hooks.onIdle?.();
  }
}
