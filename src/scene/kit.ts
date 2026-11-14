// La boîte à outils de la scène : matières, textures dessinées en code, petites fonctions de mouvement.
// Tout est fabriqué ici, sans aucun fichier d'image ni modèle 3D à charger.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

export const ORANGE = '#FF8A3D';
export const ORANGE_HOT = '#FFB070';
export const RED = '#FF4D4D';

/** Rapproche une valeur de sa cible, sans dépendre du nombre d'images par seconde. */
export const damp = (cur: number, target: number, lambda: number, dt: number) => cur + (target - cur) * (1 - Math.exp(-lambda * dt));
export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
export const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
export const ease = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
export const easeOut = (k: number) => 1 - Math.pow(1 - k, 3);
export const easeBack = (k: number) => { const c = 1.9; return 1 + (c + 1) * Math.pow(k - 1, 3) + c * Math.pow(k - 1, 2); };

export function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d')!, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export function radialTexture(stops: [number, string][], size = 128) {
  return canvasTexture(size, size, (g) => {
    const r = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    for (const [at, col] of stops) r.addColorStop(at, col);
    g.fillStyle = r;
    g.fillRect(0, 0, size, size);
  });
}

export const glowTex = radialTexture([[0, 'rgba(255,150,80,1)'], [0.25, 'rgba(255,120,50,.55)'], [0.6, 'rgba(255,100,40,.12)'], [1, 'rgba(255,100,40,0)']], 256);
export const whiteGlowTex = radialTexture([[0, 'rgba(255,255,255,1)'], [0.3, 'rgba(255,255,255,.4)'], [1, 'rgba(255,255,255,0)']], 128);
export const shadowTex = radialTexture([[0, 'rgba(0,0,0,.85)'], [0.55, 'rgba(0,0,0,.45)'], [1, 'rgba(0,0,0,0)']], 128);

/** Une lueur qui regarde toujours la caméra. */
export function glow(size: number, opacity = 0.6, tex: THREE.Texture = glowTex) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity, toneMapped: false }));
  s.scale.setScalar(size);
  // les lueurs se dessinent en dernier, par-dessus le verre et les écrans
  s.renderOrder = 20;
  return s;
}

/** Une ombre de contact posée au sol (pas de calcul d'ombres : ça ne coûte rien). */
export function blob(size: number, opacity = 0.7) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, opacity }));
  m.rotation.x = -Math.PI / 2;
  m.renderOrder = 1;
  return m;
}

// ── Les matières (partagées) ──
export const M = {
  pearl: new THREE.MeshPhysicalMaterial({ color: '#ECECF1', roughness: 0.34, metalness: 0, clearcoat: 0.7, clearcoatRoughness: 0.25 }),
  graphite: new THREE.MeshPhysicalMaterial({ color: '#2B2C33', roughness: 0.42, metalness: 0.25, clearcoat: 0.5, clearcoatRoughness: 0.3 }),
  lacquer: new THREE.MeshPhysicalMaterial({ color: '#08080A', roughness: 0.16, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.05 }),
  visor: new THREE.MeshPhysicalMaterial({ color: '#040405', roughness: 0.14, clearcoat: 1, clearcoatRoughness: 0.03 }),
  dark: new THREE.MeshStandardMaterial({ color: '#131318', roughness: 0.7, metalness: 0.1 }),
  suit: new THREE.MeshStandardMaterial({ color: '#1A1B22', roughness: 0.78 }),
  robe: new THREE.MeshStandardMaterial({ color: '#0C0C10', roughness: 0.85 }),
  cloth: new THREE.MeshStandardMaterial({ color: '#E9E2D6', roughness: 0.9 }),
  white: new THREE.MeshStandardMaterial({ color: '#F6F6F8', roughness: 0.7 }),
  gold: new THREE.MeshStandardMaterial({ color: '#D9B25C', roughness: 0.28, metalness: 0.95 }),
  red: new THREE.MeshStandardMaterial({ color: '#A51E2B', roughness: 0.55 }),
  green: new THREE.MeshPhysicalMaterial({ color: '#1FB57A', roughness: 0.2, transparent: true, opacity: 0.72, side: THREE.DoubleSide, clearcoat: 1 }),
  orange: new THREE.MeshBasicMaterial({ color: '#FF9248', toneMapped: false }),
  orangeDim: new THREE.MeshBasicMaterial({ color: '#B4541C', toneMapped: false }),
  light: new THREE.MeshBasicMaterial({ color: '#FFFFFF', toneMapped: false }),
};

export const rbox = (w: number, h: number, d: number, r: number, seg = 5) => new RoundedBoxGeometry(w, h, d, seg, r);
export const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material) => new THREE.Mesh(geo, mat);

/** Place un objet et le renvoie (pour écrire les assemblages en une ligne). */
export function at<T extends THREE.Object3D>(o: T, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0): T {
  o.position.set(x, y, z);
  o.rotation.set(rx, ry, rz);
  return o;
}

export function group(...children: THREE.Object3D[]) {
  const g = new THREE.Group();
  for (const c of children) g.add(c);
  return g;
}

/** Un nombre pseudo-aléatoire stable (même scène à chaque lancement). */
export function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
