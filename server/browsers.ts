// Le navigateur de l'agent : un vrai navigateur Chromium déjà installé sur l'ordinateur (Chrome, Brave,
// Edge, Chromium, Arc), avec sa fenêtre. C'est dedans que tu te connectes à Instagram, toi-même.
import { readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Les endroits habituels d'un navigateur Chromium, selon le système. */
function candidates(): string[] {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    const apps = [
      'Google Chrome.app/Contents/MacOS/Google Chrome', 'Brave Browser.app/Contents/MacOS/Brave Browser',
      'Microsoft Edge.app/Contents/MacOS/Microsoft Edge', 'Chromium.app/Contents/MacOS/Chromium', 'Arc.app/Contents/MacOS/Arc',
    ];
    return [...apps.map((a) => path.join('/Applications', a)), ...apps.map((a) => path.join(home, 'Applications', a))];
  }
  if (process.platform === 'win32') {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter((x): x is string => !!x);
    const apps = ['Google\\Chrome\\Application\\chrome.exe', 'Microsoft\\Edge\\Application\\msedge.exe', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'];
    return roots.flatMap((r) => apps.map((a) => path.join(r, a)));
  }
  const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'brave-browser', 'microsoft-edge'];
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  return names.flatMap((n) => dirs.map((d) => path.join(d, n)));
}

const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };
const list = (dir: string) => { try { return readdirSync(dir).sort().reverse(); } catch { return [] as string[]; } };

/** Le Chromium que Playwright a peut-être déjà téléchargé (« Chrome for Testing »), en dernier secours. */
function playwrightChromium(): string[] {
  const root = process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Caches/ms-playwright')
    : process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA ?? '', 'ms-playwright') : path.join(os.homedir(), '.cache/ms-playwright');
  const out: string[] = [];
  for (const d of list(root).filter((x) => /^chromium-\d+$/.test(x))) {
    if (process.platform === 'darwin') {
      for (const arch of ['chrome-mac-arm64', 'chrome-mac']) out.push(path.join(root, d, arch, 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'));
    } else if (process.platform === 'win32') out.push(path.join(root, d, 'chrome-win', 'chrome.exe'));
    else out.push(path.join(root, d, 'chrome-linux', 'chrome'));
  }
  return out;
}

/** Les navigateurs utilisables, du préféré au secours : la variable MUR_CHROME, puis Chrome, Brave, Edge, Chromium, Arc. */
export function findBrowsers(): string[] {
  const forced = process.env.MUR_CHROME;
  return [...new Set([...(forced && isFile(forced) ? [forced] : []), ...candidates().filter(isFile), ...playwrightChromium().filter(isFile)])];
}

/** « Brave Browser », « Google Chrome »… pour l'afficher. */
export function browserName(exe: string): string {
  const app = /([^/\\]+)\.app[/\\]/.exec(exe)?.[1];
  if (app) return app === 'Google Chrome for Testing' ? 'Chromium' : app;
  const base = path.basename(exe).replace(/\.exe$/i, '');
  return ({ chrome: 'Google Chrome', msedge: 'Microsoft Edge', brave: 'Brave', 'brave-browser': 'Brave', 'google-chrome': 'Google Chrome', 'google-chrome-stable': 'Google Chrome', chromium: 'Chromium', 'chromium-browser': 'Chromium', 'microsoft-edge': 'Microsoft Edge' } as Record<string, string>)[base] ?? base;
}
