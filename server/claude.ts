// Un juré = un vrai processus Claude Code, lancé sans interface (« -p »), qui parle en JSON ligne par ligne :
//   - on lui écrit la question du tour sur son entrée (stream-json) ;
//   - il raconte tout sur sa sortie : réflexion, recherche web, texte qui s'écrit, réponse finale.
// Sa séance reste ouverte d'un tour à l'autre : il se souvient de ce qu'il a dit.
// Il tourne avec le compte connecté à Claude Code, donc ton abonnement : on retire toute clé API de son
// environnement pour qu'il ne bascule jamais en facturation à l'usage.
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Quota } from '../shared/protocol.ts';

export interface ClaudeBinary { path: string; version: string }

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 15000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

/** Trouve l'exécutable `claude` (sans passer par les alias du terminal). */
export async function findClaude(): Promise<ClaudeBinary | null> {
  const home = os.homedir();
  const fromPath = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((d) => path.join(d, 'claude'));
  const candidates = [process.env.CLAUDE_BIN, ...fromPath, path.join(home, '.local/bin/claude'), path.join(home, '.claude/local/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
  for (const c of new Set(candidates.filter((x): x is string => !!x))) {
    if (!existsSync(c)) continue;
    try {
      const out = await run(c, ['--version']);
      return { path: c, version: out.trim().split(/\s+/)[0] ?? out.trim() };
    } catch { /* on essaie le suivant */ }
  }
  return null;
}

export interface JurorOptions {
  bin: string;
  /** le dossier où tourne la séance (il n'y écrit rien : il n'a aucun outil de fichiers) */
  cwd: string;
  /** fable, opus, sonnet, haiku */
  model: string;
  /** les modèles de repli, dans l'ordre, si le premier n'est pas disponible sur ton offre */
  fallbackModels?: string[];
  /** low, medium, high */
  effort: string;
  /** vrai : son seul outil est la recherche web ; faux : aucun outil */
  web: boolean;
  /** ses consignes : elles remplacent celles de Claude Code */
  systemPrompt: string;
  useApiKey?: boolean;
}

/** Ce que le juré fait pendant un tour. */
export interface JurorHooks {
  /** sa séance a démarré : on connaît son vrai modèle (rappelé si le modèle change en cours de route) */
  onReady?: (model: string) => void;
  /** Claude Code est passé sur un modèle de repli */
  onFallback?: (model: string, from: string) => void;
  onThink?: () => void;
  onSearch?: (query: string) => void;
  onSearchDone?: () => void;
  /** le texte brut du bloc en cours d'écriture, cumulé (au plus toutes les 100 ms) */
  onTyping?: (raw: string) => void;
  /** `raw` : l'événement de limite tel que Claude Code l'envoie */
  onQuota?: (q: Quota | null, raw: unknown) => void;
}

export type JurorErrorKind = 'delai' | 'modele' | 'quota' | 'arret' | 'lancement' | 'erreur';

/** Pourquoi un tour n'a pas abouti. */
export class JurorError extends Error {
  kind: JurorErrorKind;
  constructor(kind: JurorErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

type Json = Record<string, any>;

interface Turn {
  resolve: (text: string) => void;
  reject: (e: JurorError) => void;
  timer: NodeJS.Timeout;
  /** le bloc de texte en cours d'écriture */
  block: string;
  /** le dernier texte complet de l'assistant (après la recherche, s'il y en a une) */
  last: string;
  /** le code d'erreur de Claude Code (« model_not_found », « rate_limit »…) */
  code: string;
  searches: Set<string>;
  typingAt: number;
  typingTimer: NodeJS.Timeout | null;
}

const TYPING_MS = 100;
export const TURN_TIMEOUT_MS = 120_000;

/** La séance Claude Code d'un siège. Un seul tour à la fois. */
export class Juror {
  /** le vrai modèle (« claude-sonnet-5-5 »), connu peu après le démarrage */
  model = '';
  private proc: ChildProcessWithoutNullStreams | null = null;
  private stderr = '';
  private exited = false;
  private stopping = false;
  /** vrai si le programme claude n'a même pas pu être lancé */
  private unlaunched = false;
  /** vrai dès que Claude Code est passé sur un modèle de repli */
  private fellBack = false;
  private turn: Turn | null = null;
  private opts: JurorOptions;
  private hooks: JurorHooks;

  constructor(opts: JurorOptions, hooks: JurorHooks = {}) {
    this.opts = opts;
    this.hooks = hooks;
  }

  get alive() { return !!this.proc && !this.exited; }
  get busy() { return !!this.turn; }

  /** La commande complète (pour l'afficher ou la vérifier). */
  args(): string[] {
    const o = this.opts;
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--model', o.model, '--effort', o.effort,
      // mode restreint : seuls les outils listés existent (la recherche web, ou rien du tout),
      // et ni tes réglages, ni tes agents, ni tes connecteurs personnels ne s'invitent dans le mur
      '--restricted', '--tools', o.web ? 'WebSearch' : '', '--permission-mode', 'default',
      '--system-prompt', o.systemPrompt,
      '--no-session-persistence', '--disable-slash-commands', '--strict-mcp-config', '--setting-sources', ''];
    if (o.web) args.push('--allowedTools', 'WebSearch');
    const fb = (o.fallbackModels ?? []).filter((m) => m && m !== o.model);
    if (fb.length) args.push('--fallback-model', fb.join(','));
    return args;
  }

  start() {
    if (this.proc) return;
    const o = this.opts;
    const env: NodeJS.ProcessEnv = { ...process.env, MUR_DES_REELS: '1', CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: '1' };
    if (!o.useApiKey) { delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN; }
    const p = spawn(o.bin, this.args(), { cwd: o.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = p;
    readline.createInterface({ input: p.stdout }).on('line', (line) => {
      if (!line.trim()) return;
      let m: Json;
      try { m = JSON.parse(line); } catch { return; }
      this.handle(m);
    });
    p.stderr.on('data', (b: Buffer) => { this.stderr = (this.stderr + b.toString()).slice(-4000); });
    const done = (code: number | null, signal: string | null) => {
      if (this.exited) return;
      this.exited = true;
      const last = this.stderr.split('\n').filter(Boolean).slice(-2).join(' ');
      if (this.stopping) this.fail(new JurorError('arret', 'Séance arrêtée.'));
      else if (this.unlaunched) this.fail(new JurorError('lancement', 'Claude Code n’a pas pu être lancé.'));
      else this.fail(new JurorError('erreur', last || (signal ? `Claude Code s’est arrêté (${signal}).` : `Claude Code s’est arrêté (code ${code}).`)));
    };
    // « close » arrive une fois la sortie entièrement lue (contrairement à « exit »)
    p.on('close', (code, signal) => done(code, signal));
    // impossible de lancer claude (supprimé, plus exécutable…) : c'est une fin, en erreur
    p.on('error', () => { this.unlaunched = true; done(1, null); });
    p.stdin.on('error', () => { /* processus déjà parti : « close » s'en charge */ });
    // Claude Code n'annonce son modèle (message « init ») qu'au premier tour. Cette demande-ci répond
    // tout de suite, sans rien consommer : on y lit le vrai nom du modèle derrière « sonnet » ou « fable ».
    this.write({ type: 'control_request', request_id: 'init', request: { subtype: 'initialize' } });
  }

  private write(o: Json) {
    if (!this.alive) return false;
    this.proc!.stdin.write(JSON.stringify(o) + '\n');
    return true;
  }

  /**
   * Un tour : on pose la question, on attend la réponse complète.
   * Rejette (JurorError) si le juré plante, si son modèle ou son quota le lâche, ou s'il met trop longtemps.
   */
  ask(text: string, timeoutMs = TURN_TIMEOUT_MS): Promise<string> {
    return this.askContent([{ type: 'text', text }], timeoutMs);
  }

  /** Un tour avec du texte et des images (blocs « text » et « image » en base64). */
  askContent(content: Json[], timeoutMs = TURN_TIMEOUT_MS): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (this.turn) { reject(new JurorError('erreur', 'Ce juré a déjà la parole.')); return; }
      if (!this.alive) { reject(new JurorError(this.stopping ? 'arret' : this.unlaunched ? 'lancement' : 'erreur', this.unlaunched ? 'Claude Code n’a pas pu être lancé.' : 'Sa séance Claude Code n’est plus ouverte.')); return; }
      const timer = setTimeout(() => {
        // un tour bloqué ne se rattrape pas : on libère le siège
        this.fail(new JurorError('delai', `Pas de réponse après ${Math.round(timeoutMs / 1000)} secondes.`));
        this.kill();
      }, timeoutMs);
      this.turn = { resolve, reject, timer, block: '', last: '', code: '', searches: new Set(), typingAt: 0, typingTimer: null };
      this.write({ type: 'user', message: { role: 'user', content } });
    });
  }

  private endTurn(): Turn | null {
    const t = this.turn;
    if (!t) return null;
    this.turn = null;
    clearTimeout(t.timer);
    if (t.typingTimer) clearTimeout(t.typingTimer);
    return t;
  }

  private fail(e: JurorError) {
    this.endTurn()?.reject(e);
  }

  private announce(model: string) {
    if (!model || model === '<synthetic>' || model === this.model) return;
    this.model = model;
    this.hooks.onReady?.(model);
  }

  private typing(t: Turn) {
    const send = () => {
      t.typingTimer = null;
      if (this.turn !== t) return;
      t.typingAt = Date.now();
      this.hooks.onTyping?.(t.block);
    };
    const wait = TYPING_MS - (Date.now() - t.typingAt);
    if (wait <= 0) send();
    else if (!t.typingTimer) t.typingTimer = setTimeout(send, wait);
  }

  private handle(m: Json) {
    const t = this.turn;
    switch (m.type) {
      case 'control_response': {
        // la réponse à « initialize » : la liste des modèles, avec leur vrai nom
        const r = m.response ?? {};
        if (r.request_id !== 'init' || this.model) break;
        const models: Json[] = Array.isArray(r.response?.models) ? r.response.models : [];
        const alias = this.opts.model;
        const hit = models.find((x) => x.value === alias) ?? models.find((x) => String(x.resolvedModel ?? '').includes(alias));
        if (hit?.resolvedModel) this.announce(String(hit.resolvedModel));
        break;
      }
      case 'control_request':
        // une demande qu'on ne sait pas traiter : on répond tout de suite pour ne pas le bloquer
        this.write({ type: 'control_response', response: { subtype: 'error', request_id: String(m.request_id ?? ''), error: 'Non pris en charge par le Mur des reels' } });
        break;
      case 'system':
        // « init » revient à chaque tour avec le modèle demandé : après un repli, c'est le modèle
        // des réponses qui fait foi (sinon le juré changerait de modèle à l'écran à chaque tour)
        if (m.subtype === 'init') { if (!this.fellBack) this.announce(String(m.model ?? '')); }
        else if (m.subtype === 'model_fallback') {
          this.fellBack = true;
          const from = String(m.original_model ?? this.opts.model);
          const to = String(m.fallback_model ?? '');
          const changed = !!to && to !== this.model;
          this.announce(to);
          if (changed) this.hooks.onFallback?.(to, from);
        }
        break;
      case 'stream_event': {
        if (!t) break;
        const e = m.event ?? {};
        if (e.type === 'content_block_start') {
          const b = e.content_block ?? {};
          if (b.type === 'thinking') this.hooks.onThink?.();
          // un nouveau bloc de texte (par exemple après la recherche) remplace le précédent
          if (b.type === 'text') t.block = String(b.text ?? '');
        } else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
          t.block += String(e.delta.text ?? '');
          this.typing(t);
        }
        break;
      }
      case 'assistant': {
        if (!t) break;
        if (typeof m.error === 'string') t.code = m.error;
        else this.announce(String(m.message?.model ?? ''));
        const content = Array.isArray(m.message?.content) ? m.message.content : [];
        for (const c of content as Json[]) {
          if (c.type === 'text' && String(c.text ?? '').trim()) t.last = String(c.text);
          else if (c.type === 'tool_use' && c.name === 'WebSearch') {
            t.searches.add(String(c.id));
            this.hooks.onSearch?.(String(c.input?.query ?? '').replace(/\s+/g, ' ').trim().slice(0, 200));
          }
        }
        break;
      }
      case 'user': {
        if (!t) break;
        const content = Array.isArray(m.message?.content) ? m.message.content : [];
        for (const c of content as Json[]) {
          if (c.type === 'tool_result' && t.searches.delete(String(c.tool_use_id ?? ''))) this.hooks.onSearchDone?.();
        }
        break;
      }
      case 'rate_limit_event': {
        // la forme réelle (Claude Code 2.1.322) : rate_limit_info.unifiedWindows.<fenêtre>.{utilization, resetsAt, status},
        // avec « five_hour » et/ou « seven_day » selon la limite la plus proche ; resetsAt est en secondes
        const info = m.rate_limit_info ?? {};
        const w = info.unifiedWindows?.five_hour;
        this.hooks.onQuota?.(w ? { fiveHour: Number(w.utilization ?? 0), resetsAt: Number(w.resetsAt ?? 0) || null } : null, info);
        break;
      }
      case 'result': {
        const done = this.endTurn();
        if (!done) break;
        for (const _ of done.searches) this.hooks.onSearchDone?.();
        const text = String(m.result ?? '').trim() || done.last.trim();
        if (!m.is_error && m.subtype === 'success' && text) { done.resolve(text); break; }
        const code = done.code || String(m.terminal_reason ?? m.subtype ?? '');
        const kind: JurorErrorKind = /model/.test(code) ? 'modele' : /rate_limit|billing|overloaded/.test(code) ? 'quota' : 'erreur';
        done.reject(new JurorError(kind, text || `Claude Code n’a pas répondu (${code || 'erreur'}).`));
        break;
      }
    }
  }

  /** Fin d'audience : on ferme son entrée, il s'en va tout seul (et on insiste s'il traîne). */
  stop() {
    if (!this.alive) return;
    this.stopping = true;
    const p = this.proc!;
    p.stdin.end();
    setTimeout(() => { if (!this.exited) p.kill('SIGTERM'); }, 2000).unref();
    setTimeout(() => { if (!this.exited) p.kill('SIGKILL'); }, 5000).unref();
  }

  /** Arrêt immédiat (audience arrêtée, juré absent, pont qui s'arrête). */
  kill() {
    if (!this.alive) return;
    this.stopping = true;
    const p = this.proc!;
    p.kill('SIGTERM');
    setTimeout(() => { if (!this.exited) p.kill('SIGKILL'); }, 2000).unref();
  }
}
