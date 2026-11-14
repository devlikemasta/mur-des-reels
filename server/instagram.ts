// Le navigateur de l'agent. Un vrai navigateur, avec sa fenêtre, et son propre profil (séparé du tien) :
// tu t'y connectes à Instagram toi-même, une fois, et la connexion reste gardée sur ton ordinateur.
//
// Ce qu'il fait : ouvrir la page publique d'un compte, lire sa grille de reels (les vues affichées sur chaque
// miniature), ouvrir la page de quelques reels (likes, commentaires, légende). À vitesse humaine.
// Ce qu'il ne fait jamais : aimer, s'abonner, commenter, écrire un message, appeler une API cachée.
// S'il tombe sur une vérification ou une limite d'Instagram, il s'arrête net et te le dit.
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import type { IgStatus } from '../shared/protocol.ts';
import { browserName, findBrowsers } from './browsers.ts';

export const PROFILE_DIR = process.env.MUR_PROFILE ?? path.join(os.homedir(), '.mur-des-reels', 'navigateur');

/** Instagram a bloqué, demandé une vérification ou déconnecté : on arrête tout. */
export class IgBlocked extends Error {}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Une pause à vitesse humaine, entre deux bornes. */
export const pause = (min: number, max: number) => wait(min + Math.random() * (max - min));

/** « 1 623 », « 64,3 k », « 1,4 M », « 23.7K », « 1,623 » → un nombre. */
export function parseCount(text: string | null | undefined): number | null {
  if (!text) return null;
  const t = text.replace(/[  \s]/g, ' ').trim();
  const m = /^(\d{1,3}(?:[ .,]\d{3})*|\d+)(?:[.,](\d+))?\s*([kKmMbB]|mil|Md)?\b/.exec(t);
  if (!m) return null;
  const suf = (m[3] ?? '').toLowerCase();
  const int = m[1].replace(/[ .,]/g, '');
  if (!suf) {
    // « 1,623 » ou « 1.623 » : séparateur des milliers ; « 3,5 » sans suffixe ne se voit pas sur une grille
    return Number(int + (m[2] && m[2].length !== 3 ? '' : m[2] ?? ''));
  }
  const num = Number(`${int}.${m[2] ?? '0'}`);
  const mult = suf === 'k' || suf === 'mil' ? 1e3 : suf === 'm' ? 1e6 : 1e9;
  return Math.round(num * mult);
}

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
/** La date de publication d'un reel, cachée dans son code (millisecondes). */
export function takenAt(code: string): number {
  let n = 0n;
  for (const ch of code.slice(0, 11)) { const i = ALPHA.indexOf(ch); if (i < 0) return 0; n = n * 64n + BigInt(i); }
  return Number((n >> 23n) + 1314220021721n);
}

// ── Ce qu'on lit dans la page (le même code que le relevé testé sur 66 comptes le 14/11/2026) ──
const HEADER_JS = `() => {
  const meta = {};
  for (const m of document.querySelectorAll('meta[property], meta[name]')) {
    const k = m.getAttribute('property') || m.getAttribute('name'); const v = m.getAttribute('content');
    if (k && v) meta[k] = v;
  }
  const h = document.querySelector('header');
  return { meta, header: h ? (h.innerText || '').trim().slice(0, 1500) : '', title: document.title };
}`;

const GRID_JS = `(limit) => {
  const anchors = Array.from(document.querySelectorAll('a[href*="/reel/"]'));
  const seen = new Set(); const out = [];
  const textOf = (el) => ((el && (el.innerText || el.textContent)) || '').trim();
  const countToken = /^\\d{1,3}(?:[\\s\\u202f\\u00a0.,]\\d{3})*(?:[.,]\\d+)?\\s*[KMB]?$/i;
  const bg = (el) => { const m = /url\\(["']?([^"')]+)["']?\\)/.exec(getComputedStyle(el).backgroundImage || ''); return m ? m[1] : ''; };
  for (const a of anchors) {
    const href = a.getAttribute('href') || '';
    const match = href.match(/\\/reel\\/([^\\/?#]+)/i);
    if (!match) continue;
    const code = match[1];
    if (seen.has(code)) continue;
    seen.add(code);
    const rect = a.getBoundingClientRect();
    const cands = Array.from(a.querySelectorAll('span, div')).map((el) => {
      const text = textOf(el).replace(/[\\s\\u202f\\u00a0]+/g, ' ');
      return { text, box: el.getBoundingClientRect() };
    }).filter(({ text, box }) => {
      if (!countToken.test(text)) return false;
      if (box.width <= 0 || box.height <= 0) return false;
      const cx = box.left + box.width / 2, cy = box.top + box.height / 2;
      return cx >= rect.left && cx <= rect.right && cy >= rect.top && cy <= rect.bottom && cy >= rect.top + rect.height * 0.52;
    }).sort((p, q) => (q.box.top - p.box.top) || (p.box.left - q.box.left)).map(({ text }) => text);
    const img = a.querySelector('img');
    let thumb = img ? (img.currentSrc || img.src || '') : '';
    if (!thumb) for (const el of [a, ...a.querySelectorAll('div')]) { const u = bg(el); if (u) { thumb = u; break; } }
    out.push({ code, views: cands[0] || '', thumb });
    if (out.length >= limit) break;
  }
  return out;
}`;

const BLOCK_JS = `() => (document.body ? document.body.innerText : '').slice(0, 4000).toLowerCase()`;

/** Exécute dans la page une fonction écrite en texte (Playwright pour Node n'appelle pas une fonction passée en texte). */
const call = (page: Page, fn: string, arg?: unknown) => page.evaluate(`(${fn})(${arg === undefined ? '' : JSON.stringify(arg)})`);

export interface GridItem { code: string; views: number | null; thumbUrl: string }
export interface ProfileInfo { followers: number | null; missing: boolean; private: boolean }
export interface ReelInfo { likes: number | null; comments: number | null; caption: string }

/** « 1M likes, 25K comments - user on March 3, 2026: "…" » (anglais) ou « 1 M J’aime, 25 k commentaires - user le … : "…" ». */
export function parseReelMeta(desc: string): ReelInfo {
  const d = desc.replace(/[  ]/g, ' ').trim();
  const likes = /^([\d.,\s]+[KMB]?)\s*(?:likes?|j[’']aime|mentions? j[’']aime)/i.exec(d)?.[1];
  const comments = /,\s*([\d.,\s]+[KMB]?)\s*(?:comments?|commentaires?)/i.exec(d)?.[1];
  const caption = /[:：]\s*["“«]\s?([\s\S]*?)\s?["”»]\s*\.?\s*$/.exec(d)?.[1] ?? '';
  return { likes: parseCount(likes ?? null), comments: parseCount(comments ?? null), caption: caption.trim() };
}

function followersOf(raw: { meta: Record<string, string>; header: string }): number | null {
  const desc = raw.meta['og:description'] || raw.meta['description'] || '';
  const m = /([\d.,\s  ]+[KMB]?)\s+(?:followers|abonnés|abonné\(e\)s|seguidores)/i.exec(desc)
    ?? /([\d.,\s  ]+[KMB]?)\s+(?:followers|abonnés|seguidores)/i.exec(raw.header);
  return m ? parseCount(m[1].trim()) : null;
}

export class AgentBrowser {
  status: IgStatus = { state: 'off' };
  private ctx: BrowserContext | null = null;
  private page: Page | null = null;
  private exe = '';
  private onStatus: (s: IgStatus) => void;
  private watching = false;

  constructor(onStatus: (s: IgStatus) => void) {
    this.onStatus = onStatus;
    this.exe = findBrowsers()[0] ?? '';
    if (this.exe) this.status = { state: 'off', browser: browserName(this.exe) };
  }

  private set(s: IgStatus) {
    this.status = { browser: this.exe ? browserName(this.exe) : undefined, ...s };
    this.onStatus(this.status);
  }

  get connected() { return this.status.state === 'connected' && !!this.page && !this.page.isClosed(); }

  /**
   * Pour tester le mur sans compte (MUR_TEST_SANS_CONNEXION=1) : un navigateur sans fenêtre, non connecté.
   * Instagram montre alors les 12 premiers reels de chaque compte, pas plus.
   */
  private async connectTest(): Promise<void> {
    this.set({ state: 'opening' });
    const exe = findBrowsers().find((e) => /Chrome for Testing|Chromium/.test(e)) ?? this.exe;
    const b = await chromium.launch({ executablePath: exe, headless: true });
    this.ctx = await b.newContext({ locale: 'fr-FR', viewport: { width: 1180, height: 900 } });
    this.ctx.on('close', () => { this.ctx = null; this.page = null; this.set({ state: 'off' }); });
    this.page = await this.ctx.newPage();
    this.set({ state: 'connected', username: 'test-sans-connexion' });
  }

  /** Ouvre le navigateur de l'agent sur Instagram. Si tu n'es pas connecté, il attend que tu le fasses. */
  async connect(): Promise<void> {
    if (process.env.MUR_TEST_SANS_CONNEXION === '1') { if (!this.connected) await this.connectTest(); return; }
    if (!this.exe) { this.set({ state: 'error', message: 'Aucun navigateur Chromium trouvé (Chrome, Brave, Edge ou Arc).' }); return; }
    if (this.status.state === 'opening' || this.status.state === 'login') { await this.page?.bringToFront().catch(() => {}); return; }
    this.set({ state: 'opening' });
    try {
      if (!this.ctx) {
        await mkdir(PROFILE_DIR, { recursive: true });
        this.ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
          executablePath: this.exe, headless: false, viewport: null, locale: 'fr-FR',
          args: ['--window-size=1180,960', '--window-position=60,60', '--no-first-run', '--no-default-browser-check'],
        });
        this.ctx.on('close', () => { this.ctx = null; this.page = null; this.set({ state: 'off' }); });
      }
      this.page = this.ctx.pages()[0] ?? await this.ctx.newPage();
      await this.page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await pause(1800, 2600);
      if (await this.loggedIn()) { await this.finishLogin(); return; }
      await this.page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
      this.set({ state: 'login', message: 'Connecte-toi à Instagram dans la fenêtre qui vient de s’ouvrir.' });
      void this.watchLogin();
    } catch (e) {
      this.set({ state: 'error', message: e instanceof Error ? e.message.split('\n')[0] : String(e) });
    }
  }

  private async loggedIn(): Promise<boolean> {
    if (!this.ctx) return false;
    const cookies = await this.ctx.cookies('https://www.instagram.com').catch(() => []);
    return cookies.some((c) => c.name === 'sessionid' && !!c.value);
  }

  /** Attend ta connexion (dix minutes au plus). */
  private async watchLogin() {
    if (this.watching) return;
    this.watching = true;
    try {
      for (let i = 0; i < 400 && this.ctx && this.status.state === 'login'; i++) {
        await wait(1500);
        if (await this.loggedIn()) { await pause(2500, 3500); await this.finishLogin(); return; }
      }
      if (this.status.state === 'login') this.set({ state: 'off', message: 'Connexion pas faite : relance « Connecter mon Instagram ».' });
    } finally { this.watching = false; }
  }

  private async finishLogin() {
    const page = this.page!;
    if (!/instagram\.com\/?$/.test(page.url().replace(/\?.*$/, ''))) {
      await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
      await pause(2000, 3000);
    }
    await this.dismiss();
    // ton nom d'utilisateur : le lien « Profil » de la barre de gauche
    const username = await call(page, `() => {
      const links = Array.from(document.querySelectorAll('a[href]'));
      const a = links.find((l) => /^(profil|profile|perfil)$/i.test((l.innerText || '').trim()))
        || links.find((l) => l.querySelector('img[alt*="profil" i], img[alt*="profile" i]'));
      const h = a ? a.getAttribute('href') || '' : '';
      const m = /^\\/([A-Za-z0-9._]+)\\/?$/.exec(h);
      return m ? m[1] : '';
    }`).catch(() => '') as string;
    this.set({ state: 'connected', username: username || undefined });
  }

  /** Les fenêtres qui gênent (« Plus tard », « Not now ») : on les ferme, rien d'autre. */
  private async dismiss() {
    const page = this.page;
    if (!page) return;
    for (const name of ['Refuser les cookies optionnels', 'Decline optional cookies', 'Rechazar cookies opcionales', 'Plus tard', 'Pas maintenant', 'Not now', 'Not Now', 'Ahora no']) {
      try {
        const b = page.getByRole('button', { name, exact: true }).first();
        if (await b.count()) { await b.click({ timeout: 1200 }); await pause(700, 1300); return; }
      } catch { /* rien à fermer */ }
    }
  }

  /** Instagram demande de se reconnecter, une vérification, ou de ralentir : on s'arrête. */
  private async checkBlock() {
    const page = this.page!;
    const url = page.url();
    if (/\/accounts\/login/.test(url)) { this.set({ state: 'off', message: 'Instagram t’a déconnecté : reconnecte-toi.' }); throw new IgBlocked('Instagram demande de se reconnecter. J’arrête.'); }
    if (/challenge|checkpoint|\/suspended/.test(url)) throw new IgBlocked('Instagram demande une vérification. Fais-la dans la fenêtre de l’agent, puis relance. J’arrête.');
    const text = String(await call(page, BLOCK_JS).catch(() => ''));
    if (/try again later|réessayez plus tard|temporarily blocked|temporairement bloqué|wait a few minutes|patientez quelques minutes/.test(text)) {
      throw new IgBlocked('Instagram demande de ralentir. J’arrête : réessaie dans quelques heures.');
    }
  }

  private requirePage(): Page {
    if (!this.connected) throw new IgBlocked('Le navigateur de l’agent n’est plus connecté à Instagram.');
    return this.page!;
  }

  /** La page publique d'un compte : ses abonnés. */
  async profile(handle: string): Promise<ProfileInfo> {
    const page = this.requirePage();
    await page.goto(`https://www.instagram.com/${encodeURIComponent(handle)}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await pause(3200, 5200);
    await this.dismiss();
    await this.checkBlock();
    const raw = await call(page, HEADER_JS) as { meta: Record<string, string>; header: string; title: string };
    const text = String(await call(page, BLOCK_JS).catch(() => ''));
    const missing = /pas disponible|isn.t available|not available|no está disponible/.test(text) && !raw.header;
    const priv = /this account is private|ce compte est privé/.test(text);
    return { followers: followersOf(raw), missing, private: priv };
  }

  /**
   * La grille des reels d'un compte : à chaque défilement, ce qui est apparu (un reel garde ses vues dès
   * qu'elles s'affichent). `onBatch` reçoit les nouveaux reels au fur et à mesure.
   */
  async reels(handle: string, limit: number, onBatch: (items: GridItem[]) => void | Promise<void>): Promise<GridItem[]> {
    const page = this.requirePage();
    await page.goto(`https://www.instagram.com/${encodeURIComponent(handle)}/reels/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await pause(3800, 5600);
    await this.dismiss();
    await this.checkBlock();
    const seen = new Map<string, GridItem>();
    const order: string[] = [];
    for (let step = 0; step <= 5; step++) {
      await page.mouse.move(40 + Math.random() * 30, 90 + Math.random() * 40, { steps: 8 }).catch(() => {});
      const items = await call(page, GRID_JS, limit + 6) as { code: string; views: string; thumb: string }[];
      const fresh: GridItem[] = [];
      for (const it of items) {
        const g: GridItem = { code: it.code, views: parseCount(it.views), thumbUrl: it.thumb };
        const old = seen.get(it.code);
        if (!old) { seen.set(it.code, g); order.push(it.code); if (order.length <= limit) fresh.push(g); }
        else if ((old.views == null && g.views != null) || (!old.thumbUrl && g.thumbUrl)) {
          seen.set(it.code, { ...old, views: old.views ?? g.views, thumbUrl: old.thumbUrl || g.thumbUrl });
          if (order.indexOf(it.code) < limit) fresh.push(seen.get(it.code)!);
        }
      }
      if (fresh.length) await onBatch(fresh);
      const first = order.slice(0, limit);
      if (first.length >= limit && first.every((c) => seen.get(c)!.views != null)) break;
      if (step < 5) {
        await page.mouse.wheel(0, 520 + Math.random() * 320);
        await pause(2400, 4200);
        await this.checkBlock();
      }
    }
    return order.slice(0, limit).map((c) => seen.get(c)!);
  }

  /** La page d'un reel : likes, commentaires, légende (ce que la page publique affiche). */
  async reel(code: string): Promise<ReelInfo> {
    const page = this.requirePage();
    await page.goto(`https://www.instagram.com/reel/${encodeURIComponent(code)}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await pause(3000, 4800);
    await this.dismiss();
    await this.checkBlock();
    const raw = await call(page, HEADER_JS) as { meta: Record<string, string> };
    const desc = raw.meta['og:description'] || raw.meta['description'] || '';
    const info = parseReelMeta(desc);
    if (!info.caption) info.caption = (raw.meta['og:title'] || '').replace(/^.*?:\s*/, '').replace(/^["“«]|["”»]$/g, '').trim();
    return info;
  }

  /**
   * La recherche « mots-clés » d'Instagram : les publications qu'il sort pour ce mot, dans l'ordre affiché
   * (les mieux classées d'abord). On garde leurs codes ; leur auteur se lit sur leur page.
   */
  async keyword(q: string, limit: number): Promise<string[]> {
    const page = this.requirePage();
    await page.goto(`https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(q)}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await pause(4500, 6500);
    await this.dismiss();
    await this.checkBlock();
    const seen: string[] = [];
    for (let step = 0; step < 3 && seen.length < limit; step++) {
      const found = await call(page, `() => Array.from(document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')).map((a) => { const m = new RegExp('/(?:p|reel)/([A-Za-z0-9_-]+)').exec(a.getAttribute('href') || ''); return m ? m[1] : ''; }).filter(Boolean)`) as string[];
      for (const c of found) if (!seen.includes(c)) seen.push(c);
      if (seen.length >= limit) break;
      await page.mouse.wheel(0, 700 + Math.random() * 300);
      await pause(2200, 3600);
      await this.checkBlock();
    }
    return seen.slice(0, limit);
  }

  /** La page d'une publication : son auteur, ses likes, ses commentaires, sa légende, sa miniature. */
  async post(code: string): Promise<{ handle: string | null; likes: number | null; comments: number | null; caption: string; image: string; reel: boolean }> {
    const page = this.requirePage();
    await page.goto(`https://www.instagram.com/p/${encodeURIComponent(code)}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await pause(2600, 4200);
    await this.dismiss();
    await this.checkBlock();
    const raw = await call(page, HEADER_JS) as { meta: Record<string, string> };
    const m = raw.meta;
    const desc = m['og:description'] || m['description'] || '';
    const info = parseReelMeta(desc);
    const url = m['og:url'] || page.url();
    const handle = /instagram\.com\/([A-Za-z0-9._]{1,30})\/(?:p|reel)\//.exec(url)?.[1]
      ?? /\s-\s([A-Za-z0-9._]{1,30})\s(?:on|le|el)\s/.exec(desc)?.[1] ?? null;
    const reel = /\/reel\//.test(url) || /video/.test(m['og:type'] || '') || !!m['og:video'];
    return { handle, likes: info.likes, comments: info.comments, caption: info.caption, image: m['og:image'] || '', reel };
  }

  /**
   * L'agent regarde un reel : il ouvre sa page, garde l'accroche (une demi-seconde après le début), puis une image
   * au tiers, aux deux tiers et à la fin (là où se trouve souvent l'appel à commenter). Rend le nombre d'images gardées.
   */
  async frames(code: string, files: string[]): Promise<number> {
    const page = this.requirePage();
    await page.goto(`https://www.instagram.com/reel/${encodeURIComponent(code)}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await pause(2200, 3200);
    await this.dismiss();
    await this.checkBlock();
    const video = page.locator('video').first();
    if (!(await video.count().catch(() => 0))) return 0;
    // le reel repart du début, sans le son
    await video.evaluate((v: any) => { v.muted = true; try { v.currentTime = 0; } catch { /* pas encore prêt */ } void v.play().catch(() => {}); }).catch(() => {});
    let kept = 0;
    const snap = async (i: number) => { try { await video.screenshot({ path: files[i], type: 'jpeg', quality: 72, timeout: 5000 }); kept++; } catch { /* image ratée */ } };
    await new Promise((r) => setTimeout(r, 900));
    await snap(0);
    const duration = await video.evaluate((v: any) => (Number.isFinite(v.duration) ? v.duration : 0)).catch(() => 0) as number;
    for (let i = 1; i < files.length; i++) {
      if (duration > 6) {
        // on se place au bon moment de la vidéo et on attend l'image
        const at = duration * [0, 0.34, 0.67, 0.93][i];
        const ok = await video.evaluate((v: any, t: number) => new Promise<boolean>((res) => {
          const done = () => { v.removeEventListener('seeked', done); res(true); };
          v.addEventListener('seeked', done);
          try { v.pause(); v.currentTime = t; } catch { res(false); }
          setTimeout(() => res(false), 3500);
        }), at).catch(() => false);
        await new Promise((r) => setTimeout(r, ok ? 350 : 1200));
      } else {
        await new Promise((r) => setTimeout(r, 1700));
      }
      await snap(i);
    }
    return kept;
  }

  /** Télécharge une miniature (les adresses d'Instagram expirent : on la garde tout de suite). */
  async saveThumb(url: string, file: string): Promise<boolean> {
    if (!this.ctx || !url || url.startsWith('data:')) return false;
    try {
      const r = await this.ctx.request.get(url, { timeout: 20_000 });
      if (!r.ok()) return false;
      const body = await r.body();
      if (body.length < 500) return false;
      await writeFile(file, body);
      return true;
    } catch { return false; }
  }

  /** Une capture de ce que voit l'agent (pour l'encart « son écran »). */
  async shot(file: string): Promise<boolean> {
    if (!this.page || this.page.isClosed()) return false;
    try {
      await this.page.screenshot({ path: file, type: 'jpeg', quality: 62, timeout: 8000 });
      return true;
    } catch { return false; }
  }

  async close() {
    const c = this.ctx;
    this.ctx = null; this.page = null;
    await c?.close().catch(() => {});
  }
}
