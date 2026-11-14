// L'interface par-dessus le mur : l'accueil (ton Instagram, ta niche), les compteurs, l'écran de l'agent, le fil de
// ce qu'il fait, l'analyse (en bref, puis en entier, comme un document), la fiche d'un reel pendant l'exploration,
// et le prompt pour Claude Code. Tout le texte est posé avec textContent.
import { claudePrompt } from '../shared/analysis.ts';
import type { Account, Analysis, Breakout, ClaudeInfo, IgStatus, Insight, KwPost, Phase, RunInfo } from '../shared/protocol.ts';
import { fmtViews, fmtX } from './scene/wall.ts';

export interface UIActions {
  connect(): void;
  start(niche: string): void;
  stop(): void;
  demo(): void;
  replay(id: string): void;
  folder(): void;
  fresh(): void;
  explore(): void;
  leave(): void;
  goTo(code: string): void;
}

/** Ce que l'interface sait d'un reel (pour sa fiche et pour l'analyse). */
export interface TileInfo {
  code: string;
  kind: 'reel' | 'post';
  handle: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  caption: string;
  takenAt: number;
  multiple: number | null;
  median: number | null;
  followers: number | null;
  thumb: string | null;
  query?: string;
}

/** Tout ce qu'il faut pour l'analyse complète. */
export interface ReportData {
  niche: string;
  date: number;
  read: number;
  hits: string[];
  accounts: Account[];
  breakouts: Breakout[];
  posts: KwPost[];
  frames: Record<string, string[]>;
  analysis: Analysis;
  info: (code: string) => TileInfo | null;
}

const IG_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5.2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="4.1" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="17.4" cy="6.6" r="1.3" fill="currentColor"/></svg>`;
const reelUrl = (code: string) => `https://www.instagram.com/reel/${code}/`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function btn(label: string, cls: string, onClick: () => void) { const b = el('button', `btn ${cls}`, label); b.type = 'button'; b.onclick = onClick; return b; }
function ago(t: number) {
  if (!t) return '';
  const d = Math.max(0, Math.round((Date.now() - t) / 86_400_000));
  return d === 0 ? 'aujourd’hui' : d === 1 ? 'hier' : d < 30 ? `il y a ${d} jours` : d < 60 ? 'il y a un mois' : `il y a ${Math.round(d / 30)} mois`;
}

export class UI {
  private root: HTMLElement;
  private a: UIActions;
  private home: HTMLElement;
  private igBtn: HTMLButtonElement;
  private igState: HTMLElement;
  private input: HTMLInputElement;
  private go: HTMLButtonElement;
  private chipIg: HTMLElement;
  private chipCc: HTMLElement;
  private steps: HTMLElement;
  private pill: HTMLElement;
  private counters: { read: HTMLElement; hits: HTMLElement; acc: HTMLElement };
  private list: HTMLElement;
  private screen: HTMLElement;
  private screenImg: HTMLImageElement;
  private screenTag: HTMLElement;
  private ticker: HTMLElement;
  private tickerText: HTMLElement;
  private searches: HTMLElement;
  private panel: HTMLElement;
  private report: HTMLElement;
  private card: HTMLElement;
  private hint: HTMLElement;
  private stopBtn: HTMLButtonElement;
  private history: HTMLElement;
  private toasts: HTMLElement;
  private links: HTMLElement;
  private ig: IgStatus = { state: 'off' };
  private claude: ClaudeInfo | null = null;
  private typingTimer = 0;
  private lastPanel = '';
  private data: ReportData | null = null;

  constructor(root: HTMLElement, actions: UIActions) {
    this.root = root;
    this.a = actions;
    root.dataset.mode = 'home';

    // ── la barre du haut ──
    const top = el('header', 'top');
    const brand = el('div', 'brand');
    const bot = el('span', 'bot'); bot.append(el('i'), el('i'));
    brand.append(bot, el('span', '', 'Le Mur des reels'));
    this.steps = el('ol', 'steps');
    for (const [k, label] of [['ig', 'Instagram'], ['niche', 'Ta niche'], ['comptes', 'Les comptes'], ['lecture', 'La lecture'], ['montage', 'Le montage'], ['analyse', 'L’analyse']]) {
      const li = el('li', '', label); li.dataset.s = k; this.steps.append(li);
    }
    const chips = el('div', 'chips');
    this.chipIg = el('span', 'chip');
    this.chipCc = el('span', 'chip');
    this.stopBtn = btn('Arrêter', 'sm stop', () => this.a.stop());
    chips.append(this.stopBtn, this.chipIg, this.chipCc);
    top.append(brand, this.steps, chips);

    // ── l'accueil ──
    this.home = el('section', 'home');
    const card = el('div', 'home-card card');
    const h1 = el('h1');
    h1.append(el('span', '', 'Les reels qui explosent'), el('br'), el('span', 'hot', 'dans ta niche.'));
    const lede = el('p', 'lede', 'Ton agent IA cherche dans Instagram, lit les reels de chaque compte, regarde comment les meilleurs sont montés, et t’écrit le tien.');
    const s1 = el('div', 'step s1');
    this.igBtn = el('button', 'btn ig-btn');
    this.igBtn.type = 'button';
    this.igBtn.innerHTML = IG_ICON; // icône fixe, écrite ici : aucun texte venu d'ailleurs
    this.igBtn.append(el('span', '', 'Connecter mon Instagram'));
    this.igBtn.onclick = () => this.a.connect();
    this.igState = el('span', 'ig-state');
    s1.append(el('span', 'n', '1'), this.igBtn, this.igState);
    const s2 = el('form', 'step s2');
    this.input = el('input');
    this.input.name = 'niche'; this.input.autocomplete = 'off'; this.input.spellcheck = false; this.input.maxLength = 80;
    this.input.placeholder = 'Ta niche : agents IA, restaurant, Claude Code pour le montage…';
    this.go = el('button', 'btn primary go', 'Lancer');
    this.go.type = 'submit';
    s2.append(el('span', 'n', '2'), this.input, this.go);
    s2.onsubmit = (e) => { e.preventDefault(); const v = this.input.value.trim(); if (v) this.a.start(v); else this.input.focus(); };
    const fine = el('p', 'fine', 'Il lit seulement les pages publiques, à vitesse humaine. Aucun like, aucun abonnement, aucun message.');
    this.links = el('div', 'links no-demo');
    const demo = el('button', 'link demo', 'Voir une recherche enregistrée');
    demo.type = 'button'; demo.onclick = () => this.a.demo();
    const hist = el('button', 'link', 'Mes recherches');
    hist.type = 'button'; hist.onclick = () => this.history.classList.toggle('on');
    this.links.append(demo, el('span', 'sep', '·'), hist);
    card.append(el('small', '', 'Ton agent IA'), h1, lede, s1, s2, fine, this.links);
    this.home.append(card);

    // ── pendant la recherche ──
    this.pill = el('div', 'pill');
    const counters = el('aside', 'counters');
    const ct = (cls: string, label: string) => { const d = el('div', `ct ${cls}`); const b = el('b', '', '0'); d.append(b, el('span', '', label)); counters.append(d); return b; };
    this.counters = { read: ct('read', 'reels lus'), hits: ct('hits', 'ont explosé'), acc: ct('acc', 'comptes') };
    this.list = el('aside', 'accounts card');
    this.screen = el('div', 'screen card');
    const sh = el('div', 'sh');
    this.screenTag = el('em', '', 'en direct');
    sh.append(el('i'), el('span', '', 'L’écran de l’agent'), this.screenTag);
    this.screenImg = el('img');
    this.screenImg.alt = 'Ce que voit le navigateur de l’agent';
    this.screen.append(sh, this.screenImg);
    this.ticker = el('div', 'ticker');
    const tbot = el('span', 'bot'); tbot.append(el('i'), el('i'));
    this.tickerText = el('p');
    this.ticker.append(tbot, this.tickerText);
    this.searches = el('div', 'searches');
    this.panel = el('section', 'panel card');

    // ── l'analyse complète, la fiche d'un reel, l'exploration ──
    this.report = el('div', 'report');
    this.card = el('div', 'tile-card card');
    this.hint = el('div', 'hint');
    this.hint.append(el('span', '', 'Glisse pour te déplacer · molette pour zoomer · clic droit pour tourner · clique un reel'), btn('Retour', 'sm', () => this.a.leave()));

    // ── les recherches passées, les messages ──
    this.history = el('div', 'history card');
    this.toasts = el('div', 'toasts');

    root.append(top, this.home, this.pill, counters, this.list, this.searches, this.screen, this.panel, this.ticker, this.hint, this.card, this.report, this.history, this.toasts);
    this.renderIg();
  }

  // ── l'état général ──
  setMode(mode: 'home' | 'run' | 'done') { this.root.dataset.mode = mode; if (mode === 'home') this.input.focus({ preventScroll: true }); }
  setKind(kind: 'live' | 'replay' | 'demo') { this.root.dataset.kind = kind; this.screenTag.textContent = kind === 'live' ? 'en direct' : 'enregistré'; }
  setDemo(ok: boolean) { this.links.classList.toggle('no-demo', !ok); }
  setExploring(on: boolean) { this.root.dataset.explore = on ? '1' : ''; if (!on) this.hideCard(); }

  setClaude(c: ClaudeInfo | null) {
    this.claude = c;
    this.chipCc.textContent = c?.found ? `Claude Code ${c.version ?? ''}`.trim() : 'Claude Code introuvable';
    this.chipCc.classList.toggle('bad', !c?.found);
    this.renderIg();
  }

  setIg(ig: IgStatus) { this.ig = ig; this.renderIg(); }

  private renderIg() {
    const ig = this.ig;
    const on = ig.state === 'connected';
    this.chipIg.textContent = on ? (ig.username ? `Instagram · @${ig.username}` : 'Instagram connecté') : ig.state === 'login' ? 'Instagram · connexion…' : 'Instagram · pas connecté';
    this.chipIg.classList.toggle('ok', on);
    this.igBtn.classList.toggle('done', on);
    const label = this.igBtn.querySelector('span')!;
    label.textContent = on ? (ig.username ? `Connecté · @${ig.username}` : 'Instagram connecté') : ig.state === 'opening' ? 'J’ouvre le navigateur…' : ig.state === 'login' ? 'Connecte-toi dans la fenêtre' : 'Connecter mon Instagram';
    this.igState.textContent = ig.state === 'login' ? `Une fenêtre ${ig.browser ?? ''} s’est ouverte : c’est le navigateur de ton agent.`.replace('  ', ' ')
      : ig.state === 'error' || (ig.state === 'off' && ig.message) ? (ig.message ?? '') : on && ig.browser ? `Dans ${ig.browser}, avec un profil à part.` : '';
    this.igState.classList.toggle('bad', ig.state === 'error');
    const ready = on && !!this.claude?.found;
    this.go.disabled = !ready;
    this.go.title = !this.claude?.found ? 'Claude Code est introuvable' : !on ? 'Connecte d’abord ton Instagram' : '';
    this.steps.querySelector('[data-s="ig"]')?.classList.toggle('done', on);
  }

  setPhase(p: Phase | 'niche' | 'ig') {
    const order = ['ig', 'niche', 'comptes', 'lecture', 'montage', 'analyse'];
    const at = p === 'fin' ? order.length : order.indexOf(p);
    this.steps.querySelectorAll('li').forEach((li, i) => {
      li.classList.toggle('done', i < at || (i === 0 && this.ig.state === 'connected'));
      li.classList.toggle('on', i === at);
    });
  }

  setNiche(niche: string) { this.pill.textContent = `« ${niche} »`; this.input.value = niche; }

  // ── les compteurs ──
  setCounts(read: number, hits: number, done: number, total: number) {
    this.counters.read.textContent = read.toLocaleString('fr-FR');
    const before = this.counters.hits.textContent;
    this.counters.hits.textContent = hits.toLocaleString('fr-FR');
    if (before !== this.counters.hits.textContent && hits > 0) { const b = this.counters.hits.parentElement!; b.classList.remove('flash'); void b.offsetWidth; b.classList.add('flash'); }
    this.counters.acc.textContent = total ? `${done}/${total}` : '0';
  }

  // ── les comptes ──
  setAccounts(accounts: Account[]) {
    this.list.replaceChildren(el('small', '', 'Les comptes'));
    const ul = el('ul');
    for (const a of accounts) {
      const li = el('li', a.status);
      const name = el('b', '', `@${a.handle}`);
      if (a.from === 'instagram' || a.from === 'les deux') name.append(el('em', 'src', 'insta'));
      const meta = el('span', '', a.status === 'skipped' ? (a.note ?? 'sauté') : a.median != null ? `médiane ${fmtViews(a.median)}` : a.why ?? '');
      li.append(el('i'), name, meta);
      ul.append(li);
    }
    this.list.append(ul);
  }

  // ── les recherches (web ou Instagram) ──
  addSearch(q: string, where: 'web' | 'instagram' = 'web') {
    const c = el('div', `q ${where}`);
    const icon = el('span', 'qi');
    if (where === 'instagram') icon.innerHTML = IG_ICON; else icon.textContent = '⌕';
    c.append(icon, el('span', 'qw', where === 'instagram' ? 'Instagram' : 'Web'), el('span', '', q));
    this.searches.prepend(c);
    while (this.searches.children.length > 6) this.searches.lastElementChild?.remove();
  }
  clearSearches() { this.searches.replaceChildren(); }

  // ── l'écran de l'agent ──
  setShot(src: string) {
    const img = new Image();
    img.onload = () => { this.screenImg.src = src; this.screen.classList.add('on'); };
    img.src = src;
  }

  // ── le fil ──
  say(text: string) {
    clearInterval(this.typingTimer);
    const p = this.tickerText;
    p.textContent = '';
    this.ticker.classList.add('on');
    let i = 0;
    this.typingTimer = window.setInterval(() => {
      i = Math.min(text.length, i + 2);
      p.textContent = text.slice(0, i);
      if (i >= text.length) clearInterval(this.typingTimer);
    }, 18);
  }

  // ── l'analyse en bref (le panneau de droite) ──
  setData(d: ReportData) { this.data = d; }

  /** Pendant l'écriture : l'analyse arrive section par section. À la fin : l'essentiel et les boutons. */
  setPanel(writing: boolean) {
    const d = this.data;
    if (!d) return;
    const an = d.analysis;
    const key = JSON.stringify([an, writing, d.read, d.hits.length]);
    if (key === this.lastPanel) return;
    this.lastPanel = key;
    const p = this.panel;
    p.classList.add('on');
    p.classList.toggle('writing', writing);
    this.root.dataset.panel = '1';
    p.replaceChildren();
    const head = el('div', 'p-head');
    head.append(el('small', '', writing ? 'L’analyse s’écrit…' : 'L’analyse'));
    if (!writing) head.append(el('h2', '', `${d.hits.length} reels ont explosé sur ${d.read.toLocaleString('fr-FR')}`));
    p.append(head);
    const sect = (title: string, items: Insight[]) => {
      if (!items.length) return;
      const box = el('div', 'p-sect');
      box.append(el('h3', '', title));
      const ul = el('ul');
      for (const i of items.slice(0, writing ? 4 : 2)) { const li = el('li'); li.append(el('b', '', i.title), el('span', '', i.detail)); ul.append(li); }
      box.append(ul);
      p.append(box);
    };
    sect('Les sujets qui marchent', an.topics);
    sect('Comment ils sont montés', an.editing);
    sect('Pourquoi ça marche', an.patterns);
    if (an.script?.hook) {
      const box = el('div', 'p-sect p-reel');
      box.append(el('h3', '', 'Ton prochain reel'), el('p', 'r-hook', an.script.hook));
      p.append(box);
    }
    if (writing && !an.topics.length && !an.editing.length) p.append(el('p', 'r-wait', 'Il regarde les chiffres et les images des reels qui ont explosé…'));
    if (!writing) {
      const act = el('div', 'p-actions');
      act.append(
        btn('Voir l’analyse complète', 'primary sm2', () => this.openReport()),
        btn('Copier le prompt pour Claude Code', 'sm', () => void this.copyPrompt()),
        btn('Explorer le mur', 'sm', () => this.a.explore()),
        btn('Nouvelle recherche', 'sm ghost', () => this.a.fresh()),
      );
      p.append(act);
    }
  }
  hidePanel() { delete this.root.dataset.panel; this.panel.classList.remove('on'); this.lastPanel = ''; this.panel.replaceChildren(); }

  private prompt(): string {
    const d = this.data!;
    const brk = [...d.breakouts];
    for (const c of d.hits) if (!brk.some((b) => b.code === c)) {
      const t = d.info(c);
      if (t && t.handle && t.views != null && t.multiple != null && t.median != null) brk.push({ code: c, handle: t.handle, views: t.views, thumb: t.thumb, takenAt: t.takenAt, multiple: Math.round(t.multiple * 10) / 10, followers: t.followers, median: t.median, url: reelUrl(c) });
    }
    return claudePrompt({ niche: d.niche, date: d.date, read: d.read, accounts: d.accounts.filter((a) => a.status === 'done').length, breakouts: brk, analysis: d.analysis });
  }

  async copyPrompt() {
    if (!this.data) return;
    try { await navigator.clipboard.writeText(this.prompt()); this.toast('Prompt copié : colle-le dans Claude Code, avec ton idée.'); }
    catch { this.toast('Copie impossible ici : le prompt est aussi dans le dossier de la recherche.', 'error'); }
  }

  // ── l'analyse complète, comme un document ──
  openReport() {
    const d = this.data;
    if (!d) return;
    const an = d.analysis;
    const r = this.report;
    r.replaceChildren();
    const doc = el('article', 'doc');
    const close = btn('Fermer', 'sm close', () => this.closeReport());
    const head = el('header', 'doc-head');
    head.append(el('small', '', 'L’analyse complète'), el('h1', '', `« ${d.niche} »`));
    const done = d.accounts.filter((a) => a.status === 'done').length;
    head.append(el('p', 'doc-meta', `${new Date(d.date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })} · ${d.read.toLocaleString('fr-FR')} reels lus sur ${done} comptes · ${d.hits.length} ont fait au moins trois fois la médiane de leur compte`));
    const tools = el('div', 'doc-tools');
    tools.append(btn('Copier le prompt pour Claude Code', 'primary sm2', () => void this.copyPrompt()), btn('Explorer le mur', 'sm', () => { this.closeReport(); this.a.explore(); }), btn('Ouvrir le dossier', 'sm', () => this.a.folder()));
    head.append(tools);
    doc.append(close, head);

    // les reels qui marchent
    const top = [...d.hits].map((c) => d.info(c)).filter((t): t is TileInfo => !!t).sort((a, b) => (b.multiple ?? 0) - (a.multiple ?? 0));
    if (top.length) {
      const s = el('section', 'doc-sect');
      s.append(el('h2', '', 'Les reels qui marchent'));
      const grid = el('div', 'reel-grid');
      for (const t of top.slice(0, 12)) grid.append(this.reelCard(t, an.notes[t.code]));
      s.append(grid);
      doc.append(s);
    }
    const insights = (title: string, items: Insight[], frames = false) => {
      if (!items.length) return;
      const s = el('section', 'doc-sect');
      s.append(el('h2', '', title));
      for (const i of items) {
        const row = el('div', 'insight');
        row.append(el('h3', '', i.title), el('p', '', i.detail));
        const strip = el('div', 'strip');
        for (const c of i.codes.slice(0, 4)) {
          const imgs = frames && d.frames[c]?.length ? d.frames[c] : [d.info(c)?.thumb].filter((x): x is string => !!x);
          for (const src of imgs.slice(0, frames ? 4 : 1)) {
            const a = el('button', 'shot');
            a.type = 'button';
            const im = el('img'); im.src = src; im.alt = `Image du reel ${c}`; im.loading = 'lazy';
            a.append(im);
            a.title = 'Voir ce reel sur le mur';
            a.onclick = () => { this.closeReport(); this.a.goTo(c); };
            strip.append(a);
          }
        }
        if (strip.childElementCount) row.append(strip);
        s.append(row);
      }
      doc.append(s);
    };
    insights('Les sujets qui marchent', an.topics);
    insights('Comment ils sont montés', an.editing, true);
    insights('Pourquoi ça marche', an.patterns);
    if (an.advice.length) {
      const s = el('section', 'doc-sect');
      s.append(el('h2', '', 'Mes conseils'));
      const ol = el('ol', 'advice');
      for (const c of an.advice) ol.append(el('li', '', c));
      s.append(ol);
      doc.append(s);
    }
    if (an.script) {
      const sc = an.script;
      const s = el('section', 'doc-sect script');
      s.append(el('h2', '', `Ton prochain reel${sc.title ? ` : ${sc.title}` : ''}`));
      if (sc.hook) s.append(el('p', 'r-hook', sc.hook));
      const ol = el('ol', 'r-lines'); for (const x of sc.lines) ol.append(el('li', '', x)); s.append(ol);
      if (sc.cta) s.append(el('p', 'r-cta', sc.cta));
      if (sc.screen.length) { s.append(el('h3', '', 'À l’écran')); const ul = el('ul', 'screen-list'); for (const x of sc.screen) ul.append(el('li', '', x)); s.append(ul); }
      const copy = btn('Copier le script', 'sm', async () => {
        try { await navigator.clipboard.writeText([sc.hook, ...sc.lines, sc.cta].filter(Boolean).join('\n')); this.toast('Script copié.'); } catch { this.toast('Copie impossible ici.', 'error'); }
      });
      s.append(copy);
      doc.append(s);
    }
    {
      const s = el('section', 'doc-sect');
      s.append(el('h2', '', 'Le prompt pour Claude Code'), el('p', 'doc-note', 'Colle-le dans Claude Code et écris ton idée à la place des crochets : il te fait ce type de reel avec ton idée (script, plan de tournage, textes à l’écran, montage).'));
      const pre = el('pre', 'prompt', this.prompt());
      s.append(pre, btn('Copier le prompt', 'primary sm2', () => void this.copyPrompt()));
      doc.append(s);
    }
    if (d.posts.length) {
      const s = el('section', 'doc-sect');
      s.append(el('h2', '', 'Ce que la recherche d’Instagram sort en premier'));
      const grid = el('div', 'reel-grid small');
      for (const p of d.posts.slice(0, 12)) { const t = d.info(p.code); if (t) grid.append(this.reelCard(t)); }
      s.append(grid);
      doc.append(s);
    }
    {
      const s = el('section', 'doc-sect');
      s.append(el('h2', '', 'Les comptes lus'));
      const ul = el('ul', 'acc-list');
      for (const a of d.accounts) {
        const li = el('li', a.status);
        const link = el('a', '', `@${a.handle}`); link.href = `https://www.instagram.com/${a.handle}/`; link.target = '_blank'; link.rel = 'noopener';
        li.append(link, el('span', '', a.status === 'skipped' ? (a.note ?? 'sauté') : [a.followers != null ? `${fmtViews(a.followers)} abonnés` : '', a.median != null ? `médiane ${fmtViews(a.median)} vues` : ''].filter(Boolean).join(' · ')));
        ul.append(li);
      }
      s.append(ul);
      doc.append(s);
    }
    r.append(doc);
    r.classList.add('on');
    r.scrollTop = 0;
    r.onclick = (e) => { if (e.target === r) this.closeReport(); };
  }
  closeReport() { this.report.classList.remove('on'); }
  get reportOpen() { return this.report.classList.contains('on'); }

  private reelCard(t: TileInfo, note?: string) {
    const c = el('div', 'reel-card');
    const pic = el('button', 'pic');
    pic.type = 'button';
    pic.title = 'Voir ce reel sur le mur';
    pic.onclick = () => { this.closeReport(); this.a.goTo(t.code); };
    if (t.thumb) { const im = el('img'); im.src = t.thumb; im.alt = `Reel de @${t.handle ?? '?'}`; im.loading = 'lazy'; pic.append(im); }
    if (t.multiple != null && t.kind === 'reel') pic.append(el('em', '', `×${fmtX(t.multiple)}`));
    const body = el('div', 'rc-body');
    body.append(el('b', '', t.handle ? `@${t.handle}` : 'compte inconnu'));
    body.append(el('span', 'rc-num', t.views != null ? `${fmtViews(t.views)} vues` : t.likes != null ? `${fmtViews(t.likes)} likes` : ''));
    const meta = [t.likes != null && t.views != null ? `${fmtViews(t.likes)} likes` : '', t.comments != null ? `${fmtViews(t.comments)} commentaires` : '', ago(t.takenAt)].filter(Boolean).join(' · ');
    if (meta) body.append(el('span', 'rc-meta', meta));
    if (note) body.append(el('p', 'rc-note', note));
    else if (t.caption) body.append(el('p', 'rc-note', t.caption.replace(/\s+/g, ' ').slice(0, 120)));
    const a = el('a', 'rc-link', 'Ouvrir sur Instagram ↗'); a.href = reelUrl(t.code); a.target = '_blank'; a.rel = 'noopener';
    body.append(a);
    c.append(pic, body);
    return c;
  }

  // ── la fiche d'un reel, pendant l'exploration ──
  showCard(t: TileInfo | null, at: { x: number; y: number }) {
    if (!t) { this.hideCard(); return; }
    const c = this.card;
    c.replaceChildren();
    const close = btn('×', 'sm x', () => this.hideCard());
    const pic = el('div', 'pic');
    if (t.thumb) { const im = el('img'); im.src = t.thumb; im.alt = `Reel de @${t.handle ?? '?'}`; pic.append(im); }
    if (t.multiple != null && t.kind === 'reel' && t.multiple >= 3) pic.append(el('em', '', `×${fmtX(t.multiple)}`));
    const body = el('div', 'tc-body');
    const who = el('a', 'tc-who', t.handle ? `@${t.handle}` : 'compte inconnu');
    if (t.handle) { who.href = `https://www.instagram.com/${t.handle}/`; who.target = '_blank'; who.rel = 'noopener'; }
    body.append(who);
    const big = el('div', 'tc-big');
    big.append(el('b', '', t.views != null ? fmtViews(t.views) : t.likes != null ? fmtViews(t.likes) : '?'), el('span', '', t.views != null ? 'vues' : 'likes'));
    body.append(big);
    const lines: string[] = [];
    if (t.multiple != null && t.median != null && t.kind === 'reel') lines.push(`${fmtX(t.multiple)} fois sa médiane (${fmtViews(t.median)} vues)`);
    if (t.kind === 'post' && t.query) lines.push(`Sorti dans la recherche « ${t.query} »`);
    const meta = [t.likes != null && t.views != null ? `${fmtViews(t.likes)} likes` : '', t.comments != null ? `${fmtViews(t.comments)} commentaires` : '', ago(t.takenAt)].filter(Boolean).join(' · ');
    if (meta) lines.push(meta);
    for (const l of lines) body.append(el('span', 'tc-line', l));
    const note = this.data?.analysis.notes[t.code];
    if (note) body.append(el('p', 'tc-note', note));
    else if (t.caption) body.append(el('p', 'tc-note', t.caption.replace(/\s+/g, ' ').slice(0, 160)));
    const act = el('div', 'tc-act');
    const open = el('a', 'btn primary sm2', 'Ouvrir le reel ↗'); open.href = reelUrl(t.code); open.target = '_blank'; open.rel = 'noopener';
    act.append(open, btn('Copier le lien', 'sm', async () => { try { await navigator.clipboard.writeText(reelUrl(t.code)); this.toast('Lien copié.'); } catch { this.toast(reelUrl(t.code)); } }));
    body.append(act);
    c.append(close, pic, body);
    c.classList.add('on');
    // près du clic, sans sortir de l'écran
    const frame = this.root.getBoundingClientRect();
    const w = Math.min(340, frame.width - 24), h = 230;
    let x = at.x - frame.left + 22, y = at.y - frame.top - h / 2;
    if (x + w > frame.width - 12) x = at.x - frame.left - w - 22;
    x = Math.max(12, Math.min(frame.width - w - 12, x));
    y = Math.max(70, Math.min(frame.height - h - 90, y));
    c.style.left = `${x}px`; c.style.top = `${y}px`;
  }
  hideCard() { this.card.classList.remove('on'); }

  // ── l'historique ──
  setRuns(runs: RunInfo[]) {
    const h = this.history;
    h.replaceChildren(el('small', '', 'Mes recherches'));
    if (!runs.length) { h.append(el('p', 'empty', 'Pas encore de recherche.')); return; }
    const ul = el('ul');
    for (const r of runs.slice(0, 30)) {
      const li = el('li');
      const b = el('button');
      b.type = 'button';
      const d = new Date(r.createdAt);
      b.append(el('b', '', r.niche), el('span', '', `${d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })} · ${r.read ?? 0} reels · ${r.breakouts ?? 0} ont explosé`));
      b.onclick = () => { h.classList.remove('on'); this.a.replay(r.id); };
      li.append(b);
      ul.append(li);
    }
    h.append(ul);
  }
  closeHistory() { this.history.classList.remove('on'); }

  toast(text: string, kind: 'info' | 'error' = 'info') {
    const t = el('div', `toast ${kind}`, text);
    this.toasts.append(t);
    setTimeout(() => t.classList.add('out'), 4200);
    setTimeout(() => t.remove(), 4800);
  }

  resetRun() {
    this.setCounts(0, 0, 0, 0);
    this.list.replaceChildren();
    this.clearSearches();
    this.screen.classList.remove('on');
    this.screenImg.removeAttribute('src');
    this.ticker.classList.remove('on');
    this.tickerText.textContent = '';
    this.hidePanel();
    this.closeReport();
    this.setExploring(false);
    this.data = null;
  }
}
