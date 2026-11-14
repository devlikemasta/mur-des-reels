// Une recherche, du début à la fin :
//   1. les comptes : une séance Claude Code cherche sur le web et propose les mots-clés ; le navigateur de l'agent
//      fait la recherche « mots-clés » d'Instagram et ouvre les publications qui sortent en premier (leur auteur,
//      leurs likes) ; Claude garde les 12 comptes qui parlent vraiment de ta niche ;
//   2. la lecture : l'agent ouvre chaque compte, lit sa grille de reels (les vues affichées), calcule sa médiane
//      et ouvre les reels qui ont fait au moins trois fois cette médiane ;
//   3. le montage : il regarde les meilleurs reels et en garde quatre images (l'accroche, le tiers, les deux tiers, la fin) ;
//   4. l'analyse : une seconde séance Claude Code lit les chiffres et regarde ces images : les sujets qui marchent,
//      comment ils sont montés, pourquoi ça marche, ses conseils, et ton prochain reel.
// Tout est enregistré dans Documents/Le Mur des reels/Recherches/ : la recherche se rejoue à l'identique.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { claudePrompt, emptyAnalysis, parseAnalysis } from '../shared/analysis.ts';
import { BREAKOUT_MIN, BREAKOUT_X, RECENT_MS, type Account, type Analysis, type Breakout, type ClaudeInfo, type KwPost, type Logged, type MurEvent, type Reel, type RunInfo, type ServerMsg } from '../shared/protocol.ts';
import { Juror, JurorError, type ClaudeBinary } from './claude.ts';
import { AgentBrowser, IgBlocked, pause, takenAt, type GridItem } from './instagram.ts';

export const tilde = (p: string) => (p.startsWith(os.homedir()) ? '~' + p.slice(os.homedir().length) : p);

/** Combien de comptes l'agent lit, combien de reels par compte, combien de reels il regarde en entier. */
const MAX_ACCOUNTS = Math.max(1, Math.min(12, Number(process.env.MUR_COMPTES ?? 12) || 12));
const REELS_PER_ACCOUNT = 18;
const WATCH = Math.max(0, Math.min(8, Number(process.env.MUR_REGARDE ?? 6) || 6));
/** Les publications de la recherche Instagram que l'agent ouvre (pour le premier mot-clé, puis le second). */
const POSTS_FIRST = 9;
const POSTS_NEXT = 5;
/** Les reels de moins de 48 heures n'entrent pas dans la médiane : ils grandissent encore. */
const FRESH_MS = 48 * 3600 * 1000;

const SCOUT_PROMPT = `Tu es l'éclaireur du Mur des reels, un outil qui trouve les reels qui explosent dans une niche sur Instagram.
On te donne une niche. Tu fais deux choses.
1. Les mots-clés : les deux ou trois mots qu'on taperait dans la recherche d'Instagram pour trouver les publications de cette niche,
   dans la langue de la niche (par défaut le français), du plus précis au plus large. Le premier est la niche elle-même, bien écrite.
2. Les comptes : cherche sur le web (articles, classements, sites des créateurs, liens vers leur Instagram) des comptes Instagram
   qui publient vraiment des reels sur ce sujet. Ne donne un compte que si tu as vu son nom d'utilisateur exact dans une source.
   Par défaut des comptes francophones, sauf si la niche dit autre chose. Pas de compte de fans, pas d'agrégateur.
Réponds uniquement avec ce JSON, sans rien autour :
{"mots_cles":["…","…"],"comptes":[{"handle":"nom_exact","pourquoi":"cinq à dix mots"}]}`;

const ANALYSIS_PROMPT = `Tu es l'agent du Mur des reels. Ton utilisateur veut faire des reels qui marchent dans sa niche.
On te donne les reels qui ont explosé dans cette niche (au moins trois fois la médiane des vues de leur compte), avec leurs chiffres et
leur légende, quatre images de quelques-uns (l'accroche, le tiers, les deux tiers, la fin) pour voir comment ils sont montés, et les publications que la
recherche d'Instagram sort en premier pour ce sujet.

Ton travail, toujours appuyé sur ces reels-là, jamais sur des généralités :
1. Les sujets qui marchent : deux à quatre.
2. Comment ils sont montés : deux à quatre constats concrets tirés des images (face caméra ou écran filmé, texte à l'écran dès la
   première seconde, sous-titres, cadre, décor, rythme des plans, images d'illustration).
3. Pourquoi ça marche : deux ou trois recettes (l'accroche, l'enjeu ou l'émotion, la fin et l'appel à commenter).
4. Tes conseils pour lui : trois à cinq, concrets.
5. Pour chaque reel dont tu as les images : ce qu'on y voit, en une phrase.
6. Son prochain reel, sur le modèle de la meilleure recette. L'accroche donne envie dès la première seconde. Les phrases sont écrites
   pour la bouche : une phrase = une respiration, jamais de deux-points, le tutoiement, des images concrètes, aucune promesse
   invérifiable. Reprends la recette, jamais les mots d'un autre créateur.

Réponds uniquement avec ces lignes, dans cet ordre, une information par ligne, sans titre ni markdown :
SUJET: <titre en 2 à 5 mots> | <ce qui marche, en une phrase> | <code>, <code>
MONTAGE: <titre en 2 à 5 mots> | <comment c'est monté, en une phrase concrète> | <code>, <code>
RECETTE: <titre en 2 à 5 mots> | <pourquoi ça marche, en une phrase> | <code>, <code>
CONSEIL: <un conseil concret, en une phrase>
REEL: <code> | <ce qu'on voit dans ce reel, en une phrase>
TITRE: <le titre de son reel, en 2 à 5 mots>
ACCROCHE: <la première phrase>
PHRASE: <une phrase à dire>
(six à dix lignes PHRASE)
ÉCRAN: <ce qu'on voit à l'écran à ce moment-là>
(trois à cinq lignes ÉCRAN)
FIN: <la dernière phrase>
MODÈLE: <code>, <code>`;

const isHandle = (h: string) => /^[A-Za-z0-9._]{1,30}$/.test(h);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0;
};
const fmt = (n: number | null | undefined) => (n == null ? '?' : n >= 1e6 ? `${(n / 1e6).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} M` : n >= 1e4 ? `${Math.round(n / 1e3).toLocaleString('fr-FR')} k` : Math.round(n).toLocaleString('fr-FR'));
const xfmt = (x: number) => x.toLocaleString('fr-FR', { maximumFractionDigits: x < 10 ? 1 : 0 });
const cleanHandle = (v: unknown) => String(v ?? '').trim().replace(/^@/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//, '').replace(/[/?#].*$/, '');

/** Le JSON d'une réponse, même entouré de texte ou d'un bloc de code. */
function json(text: string): any {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

function accountsOf(d: any, from?: Account['from']): Account[] {
  const list: any[] = Array.isArray(d?.comptes) ? d.comptes : [];
  const seen = new Set<string>();
  const out: Account[] = [];
  for (const c of list) {
    const handle = cleanHandle(c?.handle);
    if (!isHandle(handle) || seen.has(handle.toLowerCase())) continue;
    seen.add(handle.toLowerCase());
    const src = String(c?.source ?? '').toLowerCase();
    out.push({ handle, why: String(c?.pourquoi ?? '').slice(0, 90), status: 'waiting', from: src.includes('deux') ? 'les deux' : src.includes('insta') ? 'instagram' : src.includes('web') ? 'web' : from });
  }
  return out;
}

const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 -]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || 'recherche';

interface Live {
  info: RunInfo;
  log: Logged[];
  dir: string;
  t0: number;
  stopping: boolean;
  juror: Juror | null;
  shots: number;
}

export class Mur {
  readonly root: string;
  readonly runsDir: string;
  private runs = new Map<string, RunInfo>();
  private live: Live | null = null;
  private claude: ClaudeBinary | null;
  private browser: AgentBrowser;
  private broadcast: (m: ServerMsg) => void;

  constructor(claude: ClaudeBinary | null, browser: AgentBrowser, broadcast: (m: ServerMsg) => void, root?: string) {
    this.claude = claude;
    this.browser = browser;
    this.broadcast = broadcast;
    this.root = root ?? path.join(os.homedir(), 'Documents', 'Le Mur des reels');
    this.runsDir = path.join(this.root, 'Recherches');
  }

  async init() {
    await mkdir(this.runsDir, { recursive: true });
    for (const name of await readdir(this.runsDir).catch(() => [] as string[])) {
      const f = path.join(this.runsDir, name, 'recherche.json');
      if (!existsSync(f)) continue;
      try {
        const d = JSON.parse(await readFile(f, 'utf8')) as { run: RunInfo };
        const info = { ...d.run, folder: path.join(this.runsDir, name), status: d.run.status === 'running' ? 'stopped' : d.run.status } as RunInfo;
        this.runs.set(info.id, info);
      } catch { /* dossier abîmé : ignoré */ }
    }
  }

  hello(): { claude: ClaudeInfo; ig: AgentBrowser['status']; runs: RunInfo[]; current: { run: RunInfo; log: Logged[] } | null } {
    return {
      claude: { found: !!this.claude, version: this.claude?.version },
      ig: this.browser.status,
      runs: [...this.runs.values()].sort((a, b) => b.createdAt - a.createdAt),
      current: this.live ? { run: this.live.info, log: this.live.log } : null,
    };
  }

  /** Une image d'une recherche : /run/<id>/t/<code>.jpg (miniature), s/<n>.jpg (capture), f/<code>-<i>.jpg (image d'un reel regardé). */
  file(id: string, kind: 't' | 's' | 'f', name: string): string | null {
    const info = this.runs.get(id) ?? (this.live?.info.id === id ? this.live.info : undefined);
    if (!info || !/^[A-Za-z0-9_-]{1,48}\.jpg$/.test(name)) return null;
    const f = path.join(info.folder, kind, name);
    return existsSync(f) ? f : null;
  }

  private emit(ev: MurEvent) {
    const l = this.live;
    if (!l) return;
    const at = Date.now() - l.t0;
    l.log.push({ at, ev });
    this.broadcast({ t: 'ev', id: l.info.id, at, ev });
  }
  private say(text: string) { this.emit({ k: 'say', text }); }

  private async save() {
    const l = this.live;
    if (!l) return;
    l.info.ms = Date.now() - l.t0;
    await writeFile(path.join(l.dir, 'recherche.json'), JSON.stringify({ run: l.info, log: l.log })).catch(() => {});
  }

  private async shot() {
    const l = this.live;
    if (!l) return;
    const n = String(++l.shots).padStart(3, '0') + '.jpg';
    if (await this.browser.shot(path.join(l.dir, 's', n))) this.emit({ k: 'shot', src: `/run/${l.info.id}/s/${n}` });
  }

  private check() {
    if (this.live?.stopping) throw new JurorError('arret', 'Recherche arrêtée.');
  }

  async start(nicheRaw: string) {
    const niche = nicheRaw.replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!niche) throw new Error('Tape ta niche d’abord.');
    if (this.live) throw new Error('Une recherche tourne déjà.');
    if (!this.claude) throw new Error('Claude Code est introuvable : installe-le, connecte-toi, puis relance le mur.');
    if (!this.browser.connected) throw new Error('Connecte d’abord ton Instagram (bouton « Connecter mon Instagram »).');

    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}.${String(d.getMinutes()).padStart(2, '0')}`;
    const dir = path.join(this.runsDir, `${stamp} ${slug(niche)}`);
    for (const k of ['t', 's', 'f']) await mkdir(path.join(dir, k), { recursive: true });
    const info: RunInfo = { id: Date.now().toString(36), niche, createdAt: Date.now(), ms: 0, status: 'running', folder: dir };
    this.live = { info, log: [], dir, t0: Date.now(), stopping: false, juror: null, shots: 0 };
    this.runs.set(info.id, info);
    this.broadcast({ t: 'run', run: info });
    void this.go(niche).catch(() => {});
  }

  /** Les miniatures : les adresses d'Instagram expirent, on les garde tout de suite. */
  private async thumb(code: string, url: string): Promise<string | null> {
    const l = this.live!;
    const name = `${code}.jpg`;
    if (existsSync(path.join(l.dir, 't', name))) return `/run/${l.info.id}/t/${name}`;
    return (await this.browser.saveThumb(url, path.join(l.dir, 't', name))) ? `/run/${l.info.id}/t/${name}` : null;
  }

  private async go(niche: string) {
    const l = this.live!;
    let read = 0;
    /** tous les reels qui passent trois fois la médiane de leur compte (l'agent n'en ouvre que deux par compte) */
    let hitCount = 0;
    const breakouts: Breakout[] = [];
    /** les autres percées (pas ouvertes) et les meilleurs reels au-dessus de leur médiane, en réserve */
    const others: Breakout[] = [];
    const posts: KwPost[] = [];
    const watched = new Map<string, string[]>();
    let analysis: Analysis = emptyAnalysis();
    let accounts: Account[] = [];
    let ok = true;
    let stopped = false;
    try {
      this.emit({ k: 'open', niche, max: MAX_ACCOUNTS });
      this.emit({ k: 'phase', phase: 'comptes' });

      // ── 1. les comptes : le web, puis la recherche d'Instagram, puis le tri ──
      this.say(`Je cherche les comptes qui comptent dans « ${niche} ».`);
      this.emit({ k: 'think', what: 'comptes' });
      const scout = new Juror({ bin: this.claude!.path, cwd: l.dir, model: 'sonnet', fallbackModels: ['opus', 'haiku'], effort: 'medium', web: true, systemPrompt: SCOUT_PROMPT }, {
        onSearch: (q) => { this.emit({ k: 'search', query: q, where: 'web' }); this.say(`Je cherche sur le web : « ${q} ».`); },
      });
      l.juror = scout;
      scout.start();
      try {
        const first = json(await scout.ask(`Niche : ${niche}`, 240_000)) ?? {};
        this.check();
        const web = accountsOf(first, 'web');
        const keywords = [niche.toLowerCase(), ...((Array.isArray(first.mots_cles) ? first.mots_cles : []) as unknown[]).map((k) => String(k).trim().toLowerCase())]
          .filter((k, i, a) => k && k.length <= 60 && a.indexOf(k) === i).slice(0, 2);

        // la recherche « mots-clés » d'Instagram : l'agent ouvre les publications qui sortent en premier
        const authors = new Map<string, { posts: number; likes: number; captions: string[] }>();
        for (let qi = 0; qi < keywords.length; qi++) {
          const q = keywords[qi];
          this.check();
          this.emit({ k: 'search', query: q, where: 'instagram' });
          this.say(`Je tape « ${q} » dans la recherche d’Instagram.`);
          const codes = await this.browser.keyword(q, 24);
          await this.shot();
          const want = qi === 0 ? POSTS_FIRST : POSTS_NEXT;
          let opened = 0;
          for (const code of codes) {
            if (opened >= want) break;
            if (posts.some((p) => p.code === code)) continue;
            this.check();
            const p = await this.browser.post(code);
            opened++;
            const thumb = p.image ? await this.thumb(code, p.image) : null;
            const post: KwPost = { code, query: q, handle: p.handle, likes: p.likes, comments: p.comments, caption: p.caption.slice(0, 300), thumb, takenAt: takenAt(code), reel: p.reel };
            posts.push(post);
            this.emit({ k: 'post', post });
            if (opened === 1) await this.shot();
            if (p.handle) {
              const a = authors.get(p.handle) ?? { posts: 0, likes: 0, captions: [] };
              a.posts++; a.likes += p.likes ?? 0; if (p.caption) a.captions.push(p.caption.replace(/\s+/g, ' ').slice(0, 110));
              authors.set(p.handle, a);
              this.say(`@${p.handle} : ${fmt(p.likes)} likes sur « ${q} ».`);
            }
            await pause(900, 1800);
          }
        }

        // le tri : Claude garde les comptes qui parlent vraiment de la niche
        this.check();
        this.emit({ k: 'think', what: 'tri' });
        this.say(`J’ai ${authors.size + web.length} comptes candidats. Je garde ceux qui parlent vraiment de « ${niche} ».`);
        const fromIg = [...authors.entries()].sort((a, b) => b[1].likes - a[1].likes)
          .map(([h, a]) => `- @${h} : ${a.posts} publication${a.posts > 1 ? 's' : ''} dans les premiers résultats, ${fmt(a.likes)} likes. Légende : « ${a.captions[0] ?? ''} »`);
        const fromWeb = web.map((a) => `- @${a.handle} : ${a.why ?? ''}`);
        const second = json(await scout.ask([
          `Voici les comptes trouvés.`,
          `Dans la recherche d'Instagram (${keywords.map((k) => `« ${k} »`).join(', ')}), les auteurs des publications qui sortent en premier :`,
          fromIg.join('\n') || '(aucun)',
          `Sur le web (ta première réponse) :`,
          fromWeb.join('\n') || '(aucun)',
          ``,
          `Choisis les ${MAX_ACCOUNTS + 4} comptes à lire pour savoir quels reels explosent dans la niche « ${niche} » : des comptes qui publient vraiment sur ce sujet, de toutes tailles.`,
          `Mets d'abord ceux de la recherche Instagram qui sont dans le sujet. Écarte les comptes hors sujet, les agrégateurs et les marques sans reels.`,
          `Réponds uniquement : {"comptes":[{"handle":"…","pourquoi":"cinq à dix mots","source":"instagram | web | les deux"}]}`,
        ].join('\n'), 150_000)) ?? {};
        accounts = accountsOf(second);
        // secours : si le tri échoue, les auteurs d'Instagram puis le web
        if (accounts.length < 3) accounts = [...[...authors.keys()].map((h) => ({ handle: h, status: 'waiting' as const, from: 'instagram' as const })), ...web]
          .filter((a, i, all) => all.findIndex((b) => b.handle.toLowerCase() === a.handle.toLowerCase()) === i);
      } finally { scout.stop(); l.juror = null; }
      this.check();
      if (!accounts.length) throw new Error('Je n’ai trouvé aucun compte pour cette niche. Essaie avec d’autres mots.');
      const shown = accounts.slice(0, MAX_ACCOUNTS);
      const reserve = accounts.slice(MAX_ACCOUNTS);
      this.emit({ k: 'accounts', accounts: shown.map((a) => ({ ...a })) });
      this.say(`Je garde ${shown.length} comptes. Je les ouvre un par un.`);

      // ── 2. la lecture ──
      this.emit({ k: 'phase', phase: 'lecture' });
      for (let i = 0; i < shown.length; i++) {
        this.check();
        const acc = shown[i];
        acc.status = 'reading';
        this.emit({ k: 'account', handle: acc.handle, status: 'reading' });
        this.say(`J’ouvre @${acc.handle}.`);
        const prof = await this.browser.profile(acc.handle);
        await this.shot();
        const skip = async (note: string) => {
          acc.status = 'skipped'; acc.note = note;
          this.emit({ k: 'account', handle: acc.handle, status: 'skipped', note });
          this.say(`@${acc.handle} : ${note}, je passe.`);
          const next = reserve.shift();
          if (next) { shown.push(next); this.emit({ k: 'accounts', accounts: shown.map((a) => ({ ...a })) }); }
        };
        if (prof.missing) { await skip('compte introuvable'); continue; }
        if (prof.private) { await skip('compte privé'); continue; }
        this.check();
        await pause(1800, 3200);
        let shotDone = false;
        const items = await this.browser.reels(acc.handle, REELS_PER_ACCOUNT, async (batch: GridItem[]) => {
          const reels: Reel[] = batch.map((g) => ({ code: g.code, handle: acc.handle, views: g.views, thumb: null, takenAt: takenAt(g.code) }));
          this.emit({ k: 'reels', handle: acc.handle, reels });
          if (!shotDone) { shotDone = true; await this.shot(); }
          for (const g of batch) {
            const t = await this.thumb(g.code, g.thumbUrl);
            if (t) this.emit({ k: 'thumb', code: g.code, thumb: t });
          }
        });
        const withViews = items.filter((g) => g.views != null);
        read += withViews.length; // lus, même si le compte est sauté ensuite : le mur les compte aussi
        if (withViews.length < 4) { await skip('pas de reels lisibles'); continue; }
        const now = Date.now();
        // la médiane : les reels des six derniers mois, sans ceux de moins de 48 heures (ils grandissent encore)
        const recent = withViews.filter((g) => now - takenAt(g.code) < RECENT_MS);
        const matured = recent.filter((g) => now - takenAt(g.code) > FRESH_MS);
        const med = median((matured.length >= 4 ? matured : recent.length >= 4 ? recent : withViews).map((g) => g.views!));
        acc.status = 'done'; acc.followers = prof.followers; acc.median = med;
        this.emit({ k: 'account', handle: acc.handle, status: 'done', followers: prof.followers, median: med });
        this.say(`@${acc.handle} : ${withViews.length} reels, médiane ${fmt(med)} vues.`);
        const ranked = recent.map((g) => ({ g, x: med > 0 ? g.views! / med : 0 })).sort((a, b) => b.x - a.x);
        const hits = ranked.filter(({ g, x }) => x >= BREAKOUT_X && g.views! >= BREAKOUT_MIN);
        hitCount += hits.length;
        const asBreakout = (g: GridItem, x: number): Breakout => ({
          code: g.code, handle: acc.handle, views: g.views, thumb: this.file(l.info.id, 't', `${g.code}.jpg`) ? `/run/${l.info.id}/t/${g.code}.jpg` : null,
          takenAt: takenAt(g.code), multiple: Math.round(x * 10) / 10, followers: prof.followers, median: med, url: `https://www.instagram.com/reel/${g.code}/`,
        });
        for (const { g, x } of hits.slice(0, 2)) {
          this.check();
          await pause(2200, 3800);
          const info = await this.browser.reel(g.code);
          await this.shot();
          const b: Breakout = { ...asBreakout(g, x), likes: info.likes, comments: info.comments, caption: info.caption.slice(0, 600) };
          breakouts.push(b);
          this.emit({ k: 'breakout', reel: b });
          this.say(`Celui-là a fait ${xfmt(x)} fois sa médiane : ${fmt(g.views)} vues.`);
        }
        for (const { g, x } of ranked.slice(0, 4)) if (!breakouts.some((b) => b.code === g.code) && x >= 1.5) others.push(asBreakout(g, x));
        if (!hits.length) this.say(`Aucun reel de @${acc.handle} ne passe trois fois sa médiane.`);
        await this.save();
        if (i < shown.length - 1) await pause(4000, 7500);
      }

      // ── 3. le montage : l'agent regarde les meilleurs reels ──
      this.check();
      const pool = [...breakouts, ...others.filter((o) => o.multiple >= BREAKOUT_X)].sort((a, b) => b.multiple - a.multiple);
      const toWatch = pool.slice(0, WATCH);
      if (toWatch.length) {
        this.emit({ k: 'phase', phase: 'montage' });
        this.say(`Je regarde les ${toWatch.length} meilleurs, pour voir comment ils sont montés.`);
        for (const b of toWatch) {
          this.check();
          this.emit({ k: 'watch', code: b.code });
          this.say(`Je regarde le reel de @${b.handle} : ${fmt(b.views)} vues.`);
          const files = [1, 2, 3, 4].map((i) => path.join(l.dir, 'f', `${b.code}-${i}.jpg`));
          const kept = await this.browser.frames(b.code, files);
          await this.shot();
          const urls = files.filter((f) => existsSync(f)).map((f) => `/run/${l.info.id}/f/${path.basename(f)}`);
          if (kept && urls.length) { watched.set(b.code, urls); this.emit({ k: 'frames', code: b.code, frames: urls }); }
          await pause(1200, 2400);
        }
      }

      // ── 4. l'analyse ──
      this.check();
      this.emit({ k: 'phase', phase: 'analyse' });
      this.say(`J’ai lu ${read} reels. ${hitCount} ont explosé. J’écris l’analyse.`);
      this.emit({ k: 'think', what: 'analyse' });
      const feed = (breakouts.length >= 3 ? [...breakouts, ...others.filter((o) => o.multiple >= BREAKOUT_X)] : [...breakouts, ...others])
        .filter((b, i, all) => all.findIndex((c) => c.code === b.code) === i).sort((a, b) => b.multiple - a.multiple).slice(0, 20);
      const lines = feed.map((b) => [
        `- code ${b.code} · @${b.handle} · ${fmt(b.followers)} abonnés · ${fmt(b.views)} vues · ${xfmt(b.multiple)} fois sa médiane (${fmt(b.median)})`,
        b.likes != null || b.comments != null ? ` · ${fmt(b.likes)} likes · ${fmt(b.comments)} commentaires` : '',
        b.caption ? `\n  légende : ${b.caption.replace(/\s+/g, ' ').slice(0, 420)}` : '',
      ].join(''));
      const kw = posts.slice(0, 12).map((p) => `- code ${p.code} · @${p.handle ?? '?'} · ${fmt(p.likes)} likes · ${fmt(p.comments)} commentaires · « ${p.query} »${p.caption ? `\n  légende : ${p.caption.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`);
      const content: Record<string, unknown>[] = [{ type: 'text', text: [
        `Niche : ${niche}`,
        breakouts.length < 3 ? 'Peu de reels ont passé trois fois leur médiane : voici aussi les meilleurs au-dessus de leur médiane.' : '',
        '', 'Les reels qui ont explosé :', lines.join('\n') || '(aucun)',
        '', 'Les publications que la recherche d’Instagram sort en premier :', kw.join('\n') || '(aucune)',
        '', watched.size ? 'Les images des reels regardés suivent, dans l’ordre : l’accroche (une demi-seconde après le début), le tiers, les deux tiers, la fin.' : '',
      ].join('\n') }];
      for (const [code, urls] of watched) {
        const b = feed.find((x) => x.code === code) ?? toWatch.find((x) => x.code === code);
        content.push({ type: 'text', text: `Reel ${code} (@${b?.handle ?? '?'}, ${fmt(b?.views)} vues) :` });
        for (const u of urls) {
          try {
            const data = (await readFile(path.join(l.dir, 'f', path.basename(u)))).toString('base64');
            content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } });
          } catch { /* image manquante */ }
        }
      }
      const writer = new Juror({ bin: this.claude!.path, cwd: l.dir, model: 'fable', fallbackModels: ['opus', 'sonnet'], effort: 'medium', web: false, systemPrompt: ANALYSIS_PROMPT }, {
        onTyping: (raw) => this.emit({ k: 'typing', text: raw }),
      });
      l.juror = writer;
      writer.start();
      let text = '';
      try { text = await writer.askContent(content, 360_000); } finally { writer.stop(); l.juror = null; }
      analysis = parseAnalysis(text);
      this.emit({ k: 'result', analysis });
      const prompt = claudePrompt({ niche, date: l.info.createdAt, read, accounts: shown.filter((a) => a.status === 'done').length, breakouts: [...breakouts, ...others.filter((o) => o.multiple >= BREAKOUT_X)], analysis });
      await writeFile(path.join(l.dir, 'Analyse.md'), report(niche, read, hitCount, breakouts, analysis)).catch(() => {});
      await writeFile(path.join(l.dir, 'Prompt pour Claude Code.txt'), prompt + '\n').catch(() => {});
      this.say(analysis.script ? 'L’analyse est prête, et ton reel aussi.' : 'L’analyse est prête.');
    } catch (e) {
      if (e instanceof JurorError && e.kind === 'arret') { stopped = true; }
      else {
        ok = false;
        const msg = e instanceof IgBlocked ? e.message : e instanceof Error ? e.message : String(e);
        this.emit({ k: 'error', message: msg });
        this.say(msg);
      }
    } finally {
      this.emit({ k: 'phase', phase: 'fin' });
      this.emit({ k: 'end', ok, ms: Date.now() - l.t0, read, breakouts: hitCount, stopped });
      l.info.status = stopped ? 'stopped' : ok ? 'done' : 'error';
      l.info.read = read;
      l.info.breakouts = hitCount;
      await this.save();
      this.broadcast({ t: 'run', run: { ...l.info } });
      this.live = null;
    }
  }

  stop() {
    const l = this.live;
    if (!l) return;
    l.stopping = true;
    l.juror?.kill();
  }

  async replay(id: string): Promise<{ run: RunInfo; log: Logged[] }> {
    const info = this.runs.get(id);
    if (!info) throw new Error('Cette recherche n’existe plus.');
    const d = JSON.parse(await readFile(path.join(info.folder, 'recherche.json'), 'utf8')) as { log: Logged[] };
    return { run: info, log: d.log };
  }

  open(id?: string) {
    const dir = id ? this.runs.get(id)?.folder : this.root;
    if (!dir || !existsSync(dir)) return;
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    execFile(opener, [dir], () => {});
  }

  shutdown() {
    this.stop();
    void this.browser.close();
  }
}

/** « Analyse.md » : la même analyse que dans le mur, à garder. */
function report(niche: string, read: number, hits: number, breakouts: Breakout[], a: Analysis): string {
  const out = [`# Le Mur des reels : ${niche}`, '', `${read} reels lus. ${hits} ont fait au moins trois fois la médiane de leur compte.`, ''];
  const link = (c: string) => `[${c}](https://www.instagram.com/reel/${c}/)`;
  const block = (title: string, items: Analysis['topics']) => {
    if (!items.length) return;
    out.push(`## ${title}`, '');
    for (const i of items) out.push(`- **${i.title}** : ${i.detail}${i.codes.length ? ` (${i.codes.map(link).join(', ')})` : ''}`);
    out.push('');
  };
  if (breakouts.length) {
    out.push('## Les reels qui marchent', '');
    for (const b of [...breakouts].sort((x, y) => y.multiple - x.multiple)) out.push(`- [@${b.handle}](${b.url}) : ${fmt(b.views)} vues, ${xfmt(b.multiple)} fois sa médiane (${fmt(b.median)})${a.notes[b.code] ? `. ${a.notes[b.code]}` : ''}`);
    out.push('');
  }
  block('Les sujets qui marchent', a.topics);
  block('Comment ils sont montés', a.editing);
  block('Pourquoi ça marche', a.patterns);
  if (a.advice.length) { out.push('## Mes conseils', '', ...a.advice.map((c) => `- ${c}`), ''); }
  const s = a.script;
  if (s) {
    out.push(`## Ton prochain reel${s.title ? ` : ${s.title}` : ''}`, '', `**${s.hook}**`, '', ...s.lines, '', `**${s.cta}**`, '');
    if (s.screen.length) out.push('### À l’écran', '', ...s.screen.map((x) => `- ${x}`), '');
  }
  return out.join('\n') + '\n';
}
