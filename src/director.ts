// Le réalisateur : il reçoit ce qui se passe (en direct ou rejoué), le met en scène sur le mur et dans l'interface,
// et garde tout ce qu'on sait de chaque reel (pour sa fiche, l'analyse complète et le prompt).
// Les compteurs avancent au rythme des cases qui se retournent, pas avant.
import { emptyAnalysis, parseAnalysis } from '../shared/analysis.ts';
import { BREAKOUT_MIN, BREAKOUT_X, RECENT_MS, type Account, type Analysis, type Breakout, type KwPost, type MurEvent } from '../shared/protocol.ts';
import type { Wall } from './scene/wall.ts';
import type { ReportData, TileInfo, UI } from './ui.ts';

export class Director {
  kind: 'live' | 'replay' | 'demo' = 'live';
  active = false;
  private wall: Wall;
  private ui: UI;
  private niche = '';
  private date = Date.now();
  private accounts: Account[] = [];
  private read = 0;
  private hits = new Set<string>();
  private tiles = new Map<string, TileInfo>();
  private breakouts: Breakout[] = [];
  private posts: KwPost[] = [];
  private frames: Record<string, string[]> = {};
  private analysis: Analysis = emptyAnalysis();
  private kwQuery = '';
  private ended = false;
  private finaleSent = false;

  constructor(wall: Wall, ui: UI) {
    this.wall = wall;
    this.ui = ui;
    wall.hooks.onRead = () => { this.read++; this.counts(); };
    wall.hooks.onHits = (codes) => { for (const c of codes) this.hits.add(c); this.counts(); };
    wall.hooks.onIdle = () => { if (this.ended && !this.finaleSent) this.finale(); };
    wall.hooks.onPick = (code, at) => this.ui.showCard(code ? this.info(code) : null, at);
  }

  /** Ce qu'on sait d'un reel. */
  info(code: string): TileInfo | null {
    const t = this.tiles.get(code);
    if (!t) return null;
    if (t.kind === 'reel' && t.handle && t.views != null) {
      const a = this.accounts.find((x) => x.handle === t.handle);
      if (a?.median) { t.median = a.median; t.multiple = t.views / a.median; t.followers = a.followers ?? null; }
    }
    return t;
  }

  private tile(code: string, patch: Partial<TileInfo>) {
    const t = this.tiles.get(code) ?? { code, kind: 'reel', handle: null, views: null, likes: null, comments: null, caption: '', takenAt: 0, multiple: null, median: null, followers: null, thumb: null };
    for (const [k, v] of Object.entries(patch)) if (v !== undefined && v !== null && v !== '') (t as unknown as Record<string, unknown>)[k] = v;
    this.tiles.set(code, t);
    return t;
  }

  private counts() {
    const live = this.accounts.filter((a) => a.status !== 'skipped');
    this.ui.setCounts(this.read, this.hits.size, live.filter((a) => a.status === 'done').length, live.length);
  }

  private data(): ReportData {
    return { niche: this.niche, date: this.date, read: this.read, hits: [...this.hits], accounts: this.accounts, breakouts: this.breakouts, posts: this.posts, frames: this.frames, analysis: this.analysis, info: (c) => this.info(c) };
  }

  home() {
    this.active = false;
    this.ended = false;
    this.wall.leave();
    this.wall.reset();
    this.ui.resetRun();
    this.ui.setMode('home');
    this.ui.setPhase('niche');
  }

  private reset() {
    this.accounts = []; this.read = 0; this.hits.clear(); this.tiles.clear(); this.breakouts = []; this.posts = [];
    this.frames = {}; this.analysis = emptyAnalysis(); this.kwQuery = ''; this.ended = false; this.finaleSent = false;
    this.wall.leave();
    this.wall.reset();
    this.ui.resetRun();
  }

  private finale() {
    this.finaleSent = true;
    // les plus gros multiples d'abord : les reels ouverts par l'agent, puis les autres percées
    const ranked = [...this.hits].map((c) => this.info(c)).filter((t): t is TileInfo => !!t).sort((a, b) => (b.multiple ?? 0) - (a.multiple ?? 0)).map((t) => t.code);
    this.wall.finale(ranked);
    this.ui.setData(this.data());
    this.ui.setPanel(false);
  }

  explore() { this.wall.explore(); this.ui.setExploring(true); }
  leave() { this.wall.leave(); this.ui.setExploring(false); }
  goTo(code: string) { this.wall.goTo(code); this.ui.setExploring(true); }

  feed(ev: MurEvent) {
    switch (ev.k) {
      case 'open':
        this.reset();
        this.active = true;
        this.niche = ev.niche;
        this.date = Date.now();
        this.ui.setKind(this.kind);
        this.ui.setMode('run');
        this.ui.setNiche(ev.niche);
        break;
      case 'phase':
        this.ui.setPhase(ev.phase);
        if (ev.phase === 'lecture') this.ui.clearSearches();
        break;
      case 'think': break;
      case 'search':
        this.ui.addSearch(ev.query, ev.where ?? 'web');
        if (ev.where === 'instagram') this.kwQuery = ev.query;
        break;
      case 'post': {
        const p = ev.post;
        this.posts.push(p);
        this.tile(p.code, { kind: 'post', handle: p.handle, likes: p.likes, comments: p.comments, caption: p.caption, takenAt: p.takenAt, thumb: p.thumb, query: p.query });
        this.wall.addPosts(`Instagram · « ${this.kwQuery || p.query} »`, [{ code: p.code, likes: p.likes, thumb: p.thumb, takenAt: p.takenAt }]);
        break;
      }
      case 'accounts': {
        const old = new Map(this.accounts.map((a) => [a.handle, a]));
        this.accounts = ev.accounts.map((a) => ({ ...a, ...(old.get(a.handle) ?? {}) }));
        this.ui.setAccounts(this.accounts);
        this.counts();
        break;
      }
      case 'account': {
        const a = this.accounts.find((x) => x.handle === ev.handle);
        if (a) { a.status = ev.status; if (ev.followers !== undefined) a.followers = ev.followers; if (ev.median !== undefined) a.median = ev.median; if (ev.note) a.note = ev.note; }
        this.ui.setAccounts(this.accounts);
        if (ev.status === 'skipped') this.wall.setRowInfo(ev.handle, { note: ev.note ?? 'sauté' });
        if (ev.status === 'done') {
          this.wall.setRowInfo(ev.handle, { followers: ev.followers ?? null, median: ev.median ?? null });
          this.wall.rowDone(ev.handle, ev.median ?? null);
        }
        this.counts();
        break;
      }
      case 'reels':
        for (const r of ev.reels) this.tile(r.code, { kind: 'reel', handle: r.handle, views: r.views, takenAt: r.takenAt });
        this.wall.addReels(ev.handle, ev.reels);
        break;
      case 'thumb':
        this.tile(ev.code, { thumb: ev.thumb });
        this.wall.setThumb(ev.code, ev.thumb);
        break;
      case 'breakout': {
        const b = ev.reel;
        this.breakouts.push(b);
        this.tile(b.code, { kind: 'reel', handle: b.handle, views: b.views, likes: b.likes ?? null, comments: b.comments ?? null, caption: b.caption ?? '', takenAt: b.takenAt, thumb: b.thumb, multiple: b.multiple, median: b.median, followers: b.followers });
        this.wall.spotlight(b.code, b.multiple);
        break;
      }
      case 'watch': {
        const t = this.info(ev.code);
        this.wall.spotlight(ev.code, t?.multiple ?? 0);
        break;
      }
      case 'frames': this.frames[ev.code] = ev.frames; break;
      case 'say': this.ui.say(ev.text); break;
      case 'shot': this.ui.setShot(ev.src); break;
      case 'typing':
        this.analysis = parseAnalysis(ev.text);
        this.ui.setData(this.data());
        this.ui.setPanel(true);
        break;
      case 'result':
        this.analysis = ev.analysis;
        this.ui.setData(this.data());
        this.ui.setPanel(!this.finaleSent);
        break;
      case 'end':
        this.ended = true;
        this.active = false;
        this.ui.setMode('done');
        if (!ev.ok && !ev.stopped) this.ui.toast('La recherche s’est arrêtée en route.', 'error');
        if (!this.wall.busy) this.finale();
        break;
      case 'error': this.ui.toast(ev.message, 'error'); break;
    }
  }

  /** Une percée au sens du mur (pour un reel dont la médiane du compte est connue). */
  isHit(code: string) {
    const t = this.info(code);
    return !!t && t.kind === 'reel' && t.views != null && t.median != null && t.median > 0 && t.views / t.median >= BREAKOUT_X && t.views >= BREAKOUT_MIN && (!t.takenAt || Date.now() - t.takenAt < RECENT_MS);
  }
}
