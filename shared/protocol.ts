// Le contrat entre le mur (navigateur) et le pont (serveur Node qui pilote Claude Code et le navigateur
// de l'agent). Tout passe par une seule connexion WebSocket, en JSON. Syntaxe « effaçable » uniquement :
// ce fichier est lu tel quel par Node (sans compilation) et par Vite.

/** Une percée : au moins trois fois la médiane du compte, au moins 1 000 vues, et publiée il y a moins de six mois
 * (un vieux reel épinglé ne dit rien de ce qui marche aujourd'hui). */
export const BREAKOUT_X = 3;
export const BREAKOUT_MIN = 1000;
export const RECENT_MS = 183 * 24 * 3600 * 1000;

/** Un compte de la niche, tel que l'agent le lit. */
export interface Account {
  handle: string;
  /** pourquoi il a été retenu, en quelques mots */
  why?: string;
  /** d'où il vient : la recherche Instagram, le web, ou les deux */
  from?: 'instagram' | 'web' | 'les deux';
  followers?: number | null;
  /** la médiane des vues de ses reels (six derniers mois, sans ceux de moins de 48 heures) */
  median?: number | null;
  status: 'waiting' | 'reading' | 'done' | 'skipped';
  /** pourquoi il a été sauté (introuvable, privé, sans reels) */
  note?: string;
}

/** Un reel de la grille d'un compte. */
export interface Reel {
  code: string;
  handle: string;
  /** les vues affichées sur la grille (null si illisibles) */
  views: number | null;
  /** l'adresse de sa miniature, servie par le pont (/run/<id>/t/<code>.jpg) */
  thumb: string | null;
  /** sa date de publication (millisecondes), tirée de son code */
  takenAt: number;
}

/** Une publication sortie par la recherche « mots-clés » d'Instagram. */
export interface KwPost {
  code: string;
  query: string;
  handle: string | null;
  likes: number | null;
  comments: number | null;
  caption: string;
  thumb: string | null;
  takenAt: number;
  reel: boolean;
}

/** Un reel qui a explosé : au moins trois fois la médiane de son compte. */
export interface Breakout extends Reel {
  /** vues / médiane du compte */
  multiple: number;
  followers: number | null;
  median: number;
  likes?: number | null;
  comments?: number | null;
  caption?: string;
  url: string;
}

/** Une idée de l'analyse, appuyée sur des reels (leurs codes). */
export interface Insight { title: string; detail: string; codes: string[] }

/** Le reel que l'agent t'écrit. `lines` : les phrases à dire, une par respiration. */
export interface Script { title: string; hook: string; lines: string[]; screen: string[]; cta: string; model: string[] }

/** Tout ce que l'agent tire des reels qui ont explosé. */
export interface Analysis {
  /** les sujets qui marchent */
  topics: Insight[];
  /** comment ils sont montés */
  editing: Insight[];
  /** pourquoi ça marche : l'accroche, l'émotion, la fin */
  patterns: Insight[];
  advice: string[];
  /** ce qu'on voit dans chaque reel regardé, par code */
  notes: Record<string, string>;
  script: Script | null;
}

export type Phase = 'comptes' | 'lecture' | 'montage' | 'analyse' | 'fin';
export const PHASES: Phase[] = ['comptes', 'lecture', 'montage', 'analyse', 'fin'];

/**
 * Ce qui se passe pendant une recherche, dans l'ordre où ça arrive. Le pont l'enregistre tel quel :
 * une recherche se rejoue à l'identique (mêmes comptes, mêmes miniatures, mêmes chiffres).
 */
export type MurEvent =
  | { k: 'open'; niche: string; max: number }
  | { k: 'phase'; phase: Phase }
  /** Claude réfléchit ou écrit */
  | { k: 'think'; what: 'comptes' | 'tri' | 'analyse' }
  /** une recherche : sur le web (Claude) ou dans Instagram (le navigateur de l'agent) */
  | { k: 'search'; query: string; where?: 'web' | 'instagram' }
  /** une publication de la recherche Instagram, ouverte par l'agent */
  | { k: 'post'; post: KwPost }
  /** les comptes retenus, dans l'ordre où l'agent va les lire */
  | { k: 'accounts'; accounts: Account[] }
  /** l'agent ouvre un compte, le finit ou le saute */
  | { k: 'account'; handle: string; status: Account['status']; followers?: number | null; median?: number | null; note?: string }
  /** des reels lus sur la grille (à chaque défilement) */
  | { k: 'reels'; handle: string; reels: Reel[] }
  /** la miniature d'un reel est arrivée */
  | { k: 'thumb'; code: string; thumb: string }
  | { k: 'breakout'; reel: Breakout }
  /** l'agent regarde un reel pour voir comment il est monté ; `frames` : les images qu'il en a gardées (l'accroche, le tiers, les deux tiers, la fin) */
  | { k: 'watch'; code: string }
  | { k: 'frames'; code: string; frames: string[] }
  /** ce que l'agent dit qu'il fait (le fil en bas de l'écran) */
  | { k: 'say'; text: string }
  /** une capture de ce que voit le navigateur de l'agent */
  | { k: 'shot'; src: string }
  /** l'analyse qui s'écrit, telle qu'elle arrive */
  | { k: 'typing'; text: string }
  | { k: 'result'; analysis: Analysis }
  | { k: 'end'; ok: boolean; ms: number; read: number; breakouts: number; stopped?: boolean }
  | { k: 'error'; message: string };

/** Un événement daté (millisecondes depuis le lancement), tel qu'il est enregistré. */
export interface Logged { at: number; ev: MurEvent }

export interface RunInfo {
  id: string;
  niche: string;
  createdAt: number;
  ms: number;
  status: 'running' | 'done' | 'stopped' | 'error';
  read?: number;
  breakouts?: number;
  /** le dossier de la recherche, sur ton ordinateur */
  folder: string;
}

/** Le navigateur de l'agent et ta connexion Instagram. */
export interface IgStatus {
  state: 'off' | 'opening' | 'login' | 'connected' | 'error';
  /** ton nom d'utilisateur, s'il a pu être lu */
  username?: string;
  /** « Brave Browser », « Google Chrome »… */
  browser?: string;
  message?: string;
}

export interface ClaudeInfo { found: boolean; version?: string }

/** La part de ta fenêtre de 5 heures de Claude Code déjà utilisée (0 à 1). */
export interface Quota { fiveHour: number; resetsAt: number | null }

// ── Navigateur → serveur ──
export type ClientMsg =
  | { t: 'connect' }
  | { t: 'start'; niche: string }
  | { t: 'stop' }
  | { t: 'replay'; id: string }
  /** ouvre le dossier d'une recherche (ou celui du mur) dans le Finder */
  | { t: 'open'; id?: string };

// ── Serveur → navigateur ──
export type ServerMsg =
  | { t: 'hello'; claude: ClaudeInfo; ig: IgStatus; runs: RunInfo[]; current: { run: RunInfo; log: Logged[] } | null; build?: string }
  | { t: 'ig'; ig: IgStatus }
  | { t: 'run'; run: RunInfo }
  | { t: 'ev'; id: string; at: number; ev: MurEvent }
  | { t: 'replay'; run: RunInfo; log: Logged[] }
  | { t: 'toast'; kind: 'info' | 'error'; text: string };
