// L'agent : le cube-robot de VibesMoney (visière noire, deux yeux orange), qui flotte devant le mur.
// Il vole d'un reel à l'autre, les regarde, cligne des yeux, et sursaute quand il en trouve un qui explose.
import * as THREE from 'three';
import { at, damp, glow, group, M, mesh, rbox } from './kit.ts';

const EYE = rbox(0.11, 0.24, 0.04, 0.05, 3);

export class Agent {
  root = new THREE.Group();
  private body = new THREE.Group();
  private eyes = new THREE.Group();
  private eyeL: THREE.Mesh;
  private eyeR: THREE.Mesh;
  private halo: THREE.Sprite;
  private under: THREE.Sprite;
  /** là où il va (le monde) et là où il regarde */
  target = new THREE.Vector3();
  look = new THREE.Vector3();
  private vel = new THREE.Vector3();
  private blinkIn = 2.5;
  private blink = 0;
  private wide = 0;
  private hop = 0;
  private t = 0;
  /** sa taille (en grand sur l'accueil) */
  size = 1;
  private scale = 1;

  constructor() {
    const shell = mesh(rbox(1, 0.86, 0.86, 0.2, 6), M.lacquer);
    // les tranches empilées du logo : deux fines lames claires sur les côtés
    const rim = new THREE.MeshPhysicalMaterial({ color: '#2B2C33', roughness: 0.3, metalness: 0.4, clearcoat: 1 });
    const sideL = at(mesh(rbox(0.04, 0.7, 0.7, 0.02, 2), rim), -0.52, 0, 0);
    const sideR = at(mesh(rbox(0.04, 0.7, 0.7, 0.02, 2), rim), 0.52, 0, 0);
    const visor = at(mesh(rbox(0.82, 0.5, 0.05, 0.12, 4), M.visor), 0, 0.02, 0.43);
    const eyeMat = new THREE.MeshBasicMaterial({ color: '#FF9248', toneMapped: false });
    this.eyeL = at(mesh(EYE, eyeMat), -0.17, 0, 0);
    this.eyeR = at(mesh(EYE, eyeMat), 0.17, 0, 0);
    this.eyes.add(this.eyeL, this.eyeR);
    this.eyes.position.set(0, 0.02, 0.47);
    const eyeGlow = glow(1.1, 0.55);
    eyeGlow.position.set(0, 0.02, 0.5);
    this.halo = glow(3.2, 0.16);
    this.halo.position.set(0, 0, -0.2);
    this.under = glow(1.8, 0.4);
    this.under.position.set(0, -0.62, 0);
    this.body.add(group(shell, sideL, sideR, visor, this.eyes, eyeGlow), this.halo, this.under);
    this.root.add(this.body);
    this.root.scale.setScalar(0.92);
  }

  place(p: THREE.Vector3) { this.root.position.copy(p); this.target.copy(p); }

  /** Il a trouvé un reel qui explose. */
  surprise() { this.wide = 1; this.hop = 1; }

  update(dt: number) {
    this.t += dt;
    this.scale = damp(this.scale, this.size, 3, dt);
    this.root.scale.setScalar(0.92 * this.scale);
    const p = this.root.position;
    const before = p.clone();
    p.x = damp(p.x, this.target.x, 5.5, dt);
    p.y = damp(p.y, this.target.y, 5.5, dt);
    p.z = damp(p.z, this.target.z, 4, dt);
    this.vel.subVectors(p, before).divideScalar(Math.max(dt, 1e-3));
    // il flotte, et penche dans le sens où il va
    this.hop = Math.max(0, this.hop - dt * 2.2);
    const jump = Math.sin(this.hop * Math.PI) * 0.35;
    this.body.position.y = Math.sin(this.t * 2.1) * 0.06 + jump;
    this.body.rotation.z = damp(this.body.rotation.z, THREE.MathUtils.clamp(-this.vel.x * 0.035, -0.32, 0.32), 6, dt);
    this.body.rotation.x = damp(this.body.rotation.x, THREE.MathUtils.clamp(this.vel.y * 0.02, -0.2, 0.2), 6, dt);
    // il regarde le reel qu'il lit
    const to = new THREE.Vector3().subVectors(this.look, p);
    const yaw = Math.atan2(to.x, Math.max(0.6, to.z));
    const pitch = Math.atan2(-to.y, Math.max(0.6, Math.hypot(to.x, to.z)));
    this.body.rotation.y = damp(this.body.rotation.y, THREE.MathUtils.clamp(yaw, -0.9, 0.9) * 0.55, 5, dt);
    this.eyes.position.x = damp(this.eyes.position.x, THREE.MathUtils.clamp(yaw * 0.08, -0.06, 0.06), 8, dt);
    this.eyes.position.y = damp(this.eyes.position.y, 0.02 + THREE.MathUtils.clamp(-pitch * 0.08, -0.05, 0.05), 8, dt);
    // il cligne des yeux ; il les écarquille quand il trouve
    this.blinkIn -= dt;
    if (this.blinkIn <= 0) { this.blink = 1; this.blinkIn = 2.2 + Math.random() * 3; }
    this.blink = Math.max(0, this.blink - dt * 7);
    this.wide = Math.max(0, this.wide - dt * 1.4);
    const sy = (1 - Math.sin(this.blink * Math.PI) * 0.9) * (1 + this.wide * 0.35);
    this.eyeL.scale.set(1 + this.wide * 0.2, sy, 1);
    this.eyeR.scale.set(1 + this.wide * 0.2, sy, 1);
    (this.under.material as THREE.SpriteMaterial).opacity = 0.32 + Math.sin(this.t * 4) * 0.06 + this.wide * 0.3;
    (this.halo.material as THREE.SpriteMaterial).opacity = 0.14 + this.wide * 0.25;
  }

  /** Les yeux, dans le monde : là où part le faisceau. */
  eyesWorld(out = new THREE.Vector3()) { return this.eyes.getWorldPosition(out); }
}
