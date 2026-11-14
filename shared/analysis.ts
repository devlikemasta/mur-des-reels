// Lire l'analyse que l'agent écrit, ligne par ligne (SUJET, MONTAGE, RECETTE, CONSEIL, REEL, puis le reel :
// TITRE, ACCROCHE, PHRASE, ÉCRAN, FIN, MODÈLE), même à moitié écrite : le pont s'en sert pour le résultat final,
// le mur pour l'afficher pendant qu'elle s'écrit. Et fabriquer le prompt à coller dans Claude Code.
import type { Analysis, Breakout, Insight, Script } from './protocol.ts';

const CODE = /^[A-Za-z0-9_-]{5,}$/;
const codes = (s: string) => s.split(/[,\s]+/).map((c) => c.trim().replace(/^.*\/(?:reel|p)\//, '').replace(/\/.*$/, '')).filter((c) => CODE.test(c));

export function emptyAnalysis(): Analysis {
  return { topics: [], editing: [], patterns: [], advice: [], notes: {}, script: null };
}

export function parseAnalysis(text: string): Analysis {
  const a = emptyAnalysis();
  const s: Script = { title: '', hook: '', lines: [], screen: [], cta: '', model: [] };
  const insight = (val: string): Insight => {
    const [title = '', detail = '', c = ''] = val.split('|').map((x) => x.trim());
    return { title, detail, codes: codes(c) };
  };
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^[\s*#>-]+/, '').trim();
    const m = /^([A-ZÉÈ]+)\s*:\s*(.+)$/i.exec(line);
    if (!m) continue;
    const key = m[1].toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const val = m[2].trim();
    switch (key) {
      case 'SUJET': a.topics.push(insight(val)); break;
      case 'MONTAGE': a.editing.push(insight(val)); break;
      case 'RECETTE': a.patterns.push(insight(val)); break;
      case 'CONSEIL': a.advice.push(val); break;
      case 'REEL': { const [c = '', note = ''] = val.split('|').map((x) => x.trim()); const k = codes(c)[0]; if (k && note) a.notes[k] = note; break; }
      case 'TITRE': s.title = val; break;
      case 'ACCROCHE': s.hook = val; break;
      case 'PHRASE': s.lines.push(val); break;
      case 'ECRAN': s.screen.push(val); break;
      case 'FIN': s.cta = val; break;
      case 'MODELE': s.model = codes(val); break;
    }
  }
  a.script = s.hook || s.lines.length ? s : null;
  return a;
}

const n = (v: number | null | undefined) => (v == null ? '?' : v >= 1e6 ? `${(v / 1e6).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} M` : v >= 1e4 ? `${Math.round(v / 1e3).toLocaleString('fr-FR')} k` : Math.round(v).toLocaleString('fr-FR'));
const x = (v: number) => v.toLocaleString('fr-FR', { maximumFractionDigits: v < 10 ? 1 : 0 });

/** Le prompt « fais ce type de reel avec mon idée », à coller dans Claude Code. */
export function claudePrompt(o: { niche: string; date: number; read: number; accounts: number; breakouts: Breakout[]; analysis: Analysis }): string {
  const { analysis: a } = o;
  const day = new Date(o.date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  const top = [...o.breakouts].sort((p, q) => q.multiple - p.multiple).slice(0, 8);
  const L: string[] = [];
  L.push(`Tu vas m'aider à faire un reel Instagram sur le modèle de ceux qui explosent dans ma niche : « ${o.niche} ».`, '');
  L.push(`Le ${day}, mon agent a lu ${o.read} reels de ${o.accounts} comptes de cette niche. Voici ce qu'il a trouvé.`, '');
  if (top.length) {
    L.push('Les reels qui ont explosé (au moins trois fois la médiane des vues de leur compte) :');
    for (const b of top) L.push(`- @${b.handle} : ${n(b.views)} vues, ${x(b.multiple)} fois sa médiane (${n(b.median)}). ${b.url}${a.notes[b.code] ? ` Ce qu'on y voit : ${a.notes[b.code]}` : ''}`);
    L.push('');
  }
  const block = (title: string, items: Insight[]) => { if (!items.length) return; L.push(title); for (const i of items) L.push(`- ${i.title} : ${i.detail}`); L.push(''); };
  block('Les sujets qui marchent :', a.topics);
  block('Comment ils sont montés :', a.editing);
  block('Pourquoi ça marche :', a.patterns);
  if (a.advice.length) { L.push('Les conseils de mon agent :'); for (const c of a.advice) L.push(`- ${c}`); L.push(''); }
  if (a.script) {
    L.push('Le reel qu’il m’a proposé :');
    if (a.script.hook) L.push(`Accroche : ${a.script.hook}`);
    for (const p of a.script.lines) L.push(`- ${p}`);
    if (a.script.cta) L.push(`Fin : ${a.script.cta}`);
    if (a.script.screen.length) L.push(`À l'écran : ${a.script.screen.join(' / ')}`);
    L.push('');
  }
  L.push('Ce que je veux : fais ce type de reel avec mon idée.');
  L.push('Mon idée : [écris ton idée ici, en une ou deux phrases]');
  L.push('');
  L.push('1. Réécris le script pour mon idée, écrit pour l’oral : une phrase = une respiration, le tutoiement, des images concrètes, aucune promesse invérifiable.');
  L.push('2. Donne-moi le plan de tournage, plan par plan : le cadre, la durée, ce que je dis, ce qu’on voit.');
  L.push('3. Écris les textes à l’écran et les sous-titres.');
  L.push('4. Propose le montage (rythme, coupes, transitions, musique) sur le modèle de « Comment ils sont montés ».');
  L.push('Pose-moi d’abord les questions qui te manquent, puis fais tout dans l’ordre.');
  return L.join('\n');
}
