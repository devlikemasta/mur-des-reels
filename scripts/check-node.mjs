// Avant de lancer le mur : la bonne version de Node, et Claude Code installé.
import { execFileSync } from 'node:child_process';
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 22 || (maj === 22 && min < 18)) {
  console.error(`\n  Le Mur des reels demande Node.js 22.18 ou plus récent (tu as ${process.versions.node}).`);
  console.error('  Installe la dernière version sur https://nodejs.org, puis relance « npm start ».\n');
  process.exit(1);
}
try {
  execFileSync('claude', ['--version'], { stdio: 'ignore', timeout: 15000 });
} catch {
  console.warn('\n  ⚠  Claude Code n’est pas trouvé : le mur s’ouvrira en démo (une recherche enregistrée).');
  console.warn('  Installe-le (https://claude.com/claude-code), connecte-toi avec « claude », puis relance « npm start ».\n');
}
