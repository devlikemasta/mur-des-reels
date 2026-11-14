# Le Mur des reels

Tu tapes ta niche. Ton agent IA cherche dans Instagram, lit les reels des comptes de ta niche un par un, sort ceux qui ont explosé, regarde comment ils sont montés, et t'écrit le tien.

Tout se passe sous tes yeux, sur un mur de reels en 3D : un petit robot passe de case en case, chaque reel se retourne avec ses vues, et ceux qui ont percé sortent du mur en orange.

## Ce qu'il fait, en cinq temps

1. **Les comptes.** Claude propose des mots-clés et des comptes de ta niche, avec une recherche web. Le navigateur de l'agent tape ta niche dans la recherche d'Instagram, comme toi, et ouvre les publications qui sortent en premier. Claude garde les 12 comptes qui parlent vraiment de ta niche.
2. **La lecture.** Sur la grille de chaque compte, l'agent lit les vues des 18 derniers reels. Il en tire la médiane du compte : les reels des six derniers mois, sans ceux de moins de 48 heures, qui grandissent encore.
3. **Les percées.** Un reel qui fait au moins trois fois la médiane de son compte, au moins 1 000 vues, et publié il y a moins de six mois, sort du mur. Un vieux reel épinglé ne dit rien de ce qui marche aujourd'hui.
4. **Le montage.** L'agent ouvre les 6 meilleurs et en garde quatre images : l'accroche, le tiers, les deux tiers et la fin.
5. **L'analyse.** Claude regarde ces images et les chiffres, puis écrit les sujets qui marchent, comment ils sont montés, pourquoi ça marche, ses conseils, et ton prochain reel : le titre, l'accroche, les phrases à dire, les plans, l'appel à commenter.

À la fin, l'analyse complète s'ouvre dans l'appli, avec un bouton pour copier un prompt à coller dans Claude Code : « fais-moi ce type de reel, avec mon idée ». Tu peux aussi te promener dans le mur en 3D et cliquer n'importe quel reel pour l'ouvrir sur Instagram.

Tout est rangé dans `Documents/Le Mur des reels/Recherches/`, un dossier par recherche : `Analyse.md`, `Prompt pour Claude Code.txt`, et `recherche.json`. Le lien « Mes recherches » de l'accueil rejoue n'importe quelle recherche passée, à l'identique.

Une recherche prend environ un quart d'heure.

## Installer

Il te faut :

- [Node.js](https://nodejs.org) 22.18 ou plus récent ;
- [Claude Code](https://claude.com/claude-code), connecté à ton compte Claude (lance `claude` une fois dans le Terminal) ;
- Google Chrome, Brave ou Microsoft Edge : c'est le navigateur de l'agent, avec un profil à part.

```bash
git clone https://github.com/devlikemasta/mur-des-reels.git
cd mur-des-reels
npm install
npm start
```

Le mur s'ouvre sur http://localhost:5050.

Le plus simple : ouvre Claude Code et colle cette phrase.

> Clone https://github.com/devlikemasta/mur-des-reels, installe-le et lance-le avec npm start.

Sur Windows, si le mur ne trouve pas Claude Code, lance-le depuis PowerShell avec `$env:CLAUDE_BIN = (Get-Command claude).Source`, puis `npm start`.

## Ton Instagram

1. Clique sur « Connecter mon Instagram ». Une fenêtre de ton navigateur s'ouvre : c'est le navigateur de ton agent. Il a son propre profil (`~/.mur-des-reels/navigateur`), sans tes onglets ni tes mots de passe habituels.
2. Connecte-toi à Instagram dans cette fenêtre, une seule fois. La connexion reste sur ton ordinateur.
3. Tape ta niche (« agents IA », « restaurant », « coach sportif »…) et clique sur Lancer.

L'agent lit seulement des pages publiques, à vitesse humaine. Aucun like, aucun abonnement, aucun message. Si Instagram demande une vérification, il s'arrête et te le dit.

Instagram peut freiner un compte qui navigue beaucoup. Utilise un compte secondaire si tu en as un, et compte une ou deux recherches par jour.

## Filmer

| Touche | Effet |
|---|---|
| `F` | mode cinéma : sans la barre du haut ni la liste des comptes |
| `H` | le mur seul, sans aucune interface |
| `V` | cadre vertical 9:16, pour un reel |
| `1` `2` `4` | la vitesse d'une recherche rejouée |
| `Échap` | fermer l'analyse, quitter la balade dans le mur |
| flèches, `+` `−` | se déplacer et zoomer dans le mur |

Dans le mur, à la fin : glisse pour te déplacer, molette pour zoomer, clic droit pour tourner, clic sur un reel pour sa fiche et son lien.

## Ce que ça coûte

Rien de plus que ton abonnement Claude. Une recherche, c'est deux réponses de Sonnet avec la recherche web (les mots-clés et les comptes, puis le tri des comptes), et une analyse par Fable avec les images des reels. Si ton offre ne donne pas accès à un modèle, le mur passe tout seul au suivant.

## Les réglages

Trois variables d'environnement, si tu veux changer le rythme :

- `MUR_COMPTES` : le nombre de comptes lus (12 par défaut, 12 au plus) ;
- `MUR_REGARDE` : le nombre de reels regardés pour le montage (6 par défaut) ;
- `MUR_DIR` : le dossier des recherches.

Par exemple `MUR_COMPTES=6 npm start` pour une recherche plus courte.

## Comment ça marche

```
navigateur (Three.js)  ⇄  pont Node (WebSocket, 127.0.0.1:5050)  ⇄  Claude Code (claude -p)
                                                                 ⇄  navigateur de l'agent (Playwright)
```

- `server/mur.ts` mène la recherche : les comptes, la lecture, les percées, le montage, l'analyse.
- `server/instagram.ts` pilote le navigateur de l'agent. Il lit la recherche par mots-clés d'Instagram, les grilles de reels et les publications, comme une personne, et s'arrête à la moindre vérification.
- `server/claude.ts` lance les séances Claude Code (`claude -p`, en JSON ligne par ligne). La première n'a qu'un outil, la recherche web. Celle de l'analyse n'en a aucun : elle lit les chiffres et les images qu'on lui donne.
- `shared/analysis.ts` lit l'analyse et écrit le prompt pour Claude Code.
- `src/` est le mur : les cases, le robot, le faisceau et la caméra sont dessinés en code, sans aucun fichier 3D à charger.
- `src/director.ts` met en scène : les compteurs avancent au rythme des cases qui se retournent.

Le pont n'écoute que sur ton ordinateur et refuse toute page qui ne vient pas du mur.

## Licence

MIT. Fait par [VibesMoney](https://vibesmoney.com), où l'on apprend à créer des agents IA qui travaillent pour toi.

---

**In English.** The Reels Wall: type a niche and your AI agent searches Instagram, reads each account's reels one by one, pulls out the ones that broke out (at least three times the account's median views), looks at how the best ones are edited, and writes your next reel. Runs locally on your Claude subscription, with its own browser profile for Instagram (public pages only, human pace, no likes, follows or messages). `npm install && npm start`, then open http://localhost:5050. The interface and the analysis are in French.
