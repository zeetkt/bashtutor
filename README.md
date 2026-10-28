# Bash Tutor

[![CI](https://github.com/zeetkt/bashtutor/actions/workflows/ci.yml/badge.svg)](https://github.com/zeetkt/bashtutor/actions/workflows/ci.yml)
[![Démo](https://img.shields.io/badge/d%C3%A9mo-zeetkt.github.io%2Fbashtutor-1f6feb)](https://zeetkt.github.io/bashtutor/)

Visualiseur d'exécution Bash pas à pas, façon [Python Tutor](https://pythontutor.com/). 100 % côté navigateur : aucun serveur, aucune exécution réelle sur ta machine. Un moteur Bash virtuel (WASM) simule le script et l'interface affiche, à **chaque commande exécutée**, les variables, le contexte et la sortie produite.

> Une boucle `for` produit **une étape par itération**. Un `if` ne montre **que la branche exécutée** et l'évaluation de sa condition. Tu vois les variables changer en temps réel, comme si tu déboguais ligne par ligne.

## Aperçu

```
┌────────────────────────────────────────────────────────────────────┐
│  Bash Tutor   [Exemple ▾]  [Visualiser]  [Partager]  [◐]  Prêt ✓  │
├──────────────────────┬──────────────────────┬──────────────────────┤
│  Script Bash         │  Exécution pas à pas │  Variables/Contexte  │
│  (éditeur CodeMirror │  (ligne courante     │  /Sortie (onglets)   │
│   + ligne surlignée) │  surlignée)          │                      │
│                      ├──────────────────────┤                      │
│                      │  Exécution : …       │                      │
│                      │  i = "1" · somme : … │                      │
├──────────────────────┴──────────────────────┴──────────────────────┤
│  ⏮ ◀ 3 / 13 ▶ ⏭  ────────●────────  [Lecture]  Vitesse ▾          │
└────────────────────────────────────────────────────────────────────┘
```

## Fonctionnalités

- **Pas à pas commande par commande** — pas statement par statement. Les itérations de boucles, les branches de conditionnelles et les **conditions** (`if` / `elif` / `while` / `until`, vraies ou fausses) deviennent des étapes distinctes.
- **État après chaque commande** — variables scalaires, tableaux indexés, tableaux associatifs, flags (`readonly`, `export`), répertoire courant, code de sortie (`$?`), arguments (`$0`, `$#`, `$@`).
- **Diff visuel + explication en clair** — les variables ajoutées / modifiées / supprimées sont colorées, avec une phrase courte du type `somme : "0" → "1"`.
- **Sortie segmentée** — stdout et stderr de chaque étape affichés séparément, avec mise en évidence de l'étape courante. La sortie est restituée **exactement** (y compris `printf` sans retour à la ligne).
- **Détection d'erreurs** — les erreurs de syntaxe sont localisées (ligne soulignée dans l'éditeur et dans la trace) avant exécution ; les erreurs d'exécution sont signalées en français.
- **Limite de sécurité** — un script trop long (boucle infinie, etc.) est tronqué après 200 commandes et l'interface le signale.
- **Navigation confortable** — lecture automatique avec réglage de vitesse, curseur de progression, clics sur les numéros de ligne, raccourcis clavier.
- **Partage** — le script est encodé dans l'URL (`#code=…`) : bouton « Partager », liens reproductibles, restauration automatique via `localStorage`.
- **Thème clair / sombre**, interface responsive (mobile incluse), accessible au clavier (onglets ARIA, libellés, `aria-live`).
- **6 exemples pédagogiques** intégrés : somme, tableaux, associatifs, fonctions, pipelines, conditions.

## Démarrage rapide

```bash
git clone https://github.com/zeetkt/bashtutor.git
cd bashtutor
npm install
npm run dev      # http://localhost:5173
```

Pré-requis : Node.js 18+ et un navigateur récent (Chrome, Firefox, Edge).

## Utilisation

1. Choisir un exemple dans la liste déroulante, ou éditer le script directement dans l'éditeur.
2. Cliquer sur **Visualiser l'exécution** (ou `Ctrl+Entrée`).
3. Naviguer entre les étapes avec ⏮ ◀ ▶ ⏭, le curseur, le bouton **Lecture**, ou les flèches `←` `→`.

Le panneau de droite affiche, pour l'étape courante (onglets) :

| Onglet | Contenu |
| --- | --- |
| **Variables** | Variables définies, avec coloration des ajouts / modifications / suppressions par rapport à l'étape précédente. |
| **Contexte** | `$PWD`, `$0`, `$#`, `$@`, `$?`, succès. |
| **Sortie** | stdout / stderr de chaque étape (l'étape courante est surlignée et auto-scrollée). |

### Raccourcis clavier

| Touche | Action |
| --- | --- |
| `←` / `→` | Étape précédente / suivante |
| `Début` / `Fin` | Première / dernière étape |
| `Échap` | Arrêter la lecture |
| `Ctrl+Entrée` / `Cmd+Entrée` | Relancer l'exécution |

Dans l'éditeur ou un champ de formulaire, les flèches gardent leur rôle d'édition.

## Comment ça marche (en bref)

bashkit-wasm ne permet pas d'interrompre l'exécution ni de lire l'état interne en cours de run. Bash Tutor contourne cela par une **instrumentation du script** :

1. Le script est analysé avec tree-sitter pour localiser chaque commande exécutable (avec un identifiant de nœud et son texte exact).
2. Des sondes (`__bt_before` / `__bt_after`) sont injectées autour de chaque commande et de chaque condition.
3. Le script instrumenté est exécuté en **un seul appel** `executeSync`.
4. Les journaux et marqueurs (`0x1E` + jeton aléatoire) sont découpés et reconstruits en étapes (texte, lignes, variables, contexte, sortie).

Les sondes restituent le code de sortie (`$?`) et reçoivent `$0`/`$#`/`$*` depuis le site d'appel : les conditions et les tests de statut restent donc fidèles à Bash.

👉 Le détail complet (AST, protocole de marqueurs, reconstruction, contraintes bashkit) est dans [ARCHITECTURE.md](./ARCHITECTURE.md).

## Structure du projet

```
bashtutor/
├── index.html              # structure de la page (header + grille 3 panneaux + contrôles)
├── style.css               # thèmes clair/sombre, layout grid responsive, classes de diff
├── vite.config.js          # base relative (déploiement sous /bashtutor/)
├── package.json            # scripts : dev / build / preview / test
├── .gitattributes          # fins de ligne LF pour les scripts et le code
├── .github/workflows/      # CI (test + build) et déploiement GitHub Pages
├── public/                 # assets WASM servis tels quels
│   ├── bashkit.wasm        # moteur Bash virtuel (Rust → WASM)
│   ├── tree-sitter-bash.wasm  # grammaire tree-sitter
│   ├── web-tree-sitter.wasm   # runtime tree-sitter (core)
│   └── favicon.svg
├── examples/               # 6 scripts pédagogiques (.sh, importés en ?raw)
├── src/
│   ├── engine.js           # instrumentation + exécution + reconstruction des étapes
│   ├── parser.js           # tree-sitter : findStepNodes (commandes + conditions), firstErrorLine
│   ├── vars.js             # parse declare -p (scalaires, tableaux, associatifs)
│   ├── diff.js             # computeVarDiff (ajouts / modifs / suppressions)
│   ├── examples.js         # import des 6 exemples
│   ├── main.js             # orchestration UI + moteur + état
│   └── ui/
│       ├── editor.js       # CodeMirror 6 (shell, surlignage de ligne, thème)
│       ├── codeview.js     # rendu du script + surlignage + numéros cliquables
│       ├── panels.js       # Variables / Contexte / Sortie / explication
│       └── controls.js     # navigation, curseur, lecture auto
└── tests/
    └── engine.test.mjs     # 25 tests (node:test)
```

## Stack technique

| Rôle | Technologie |
| --- | --- |
| Moteur Bash virtuel | [`@everruns/bashkit-wasm`](https://www.npmjs.com/package/@everruns/bashkit-wasm) (Rust → WASM, exécuté en navigateur) |
| Analyse syntaxique | `web-tree-sitter` + `tree-sitter-bash` |
| Éditeur | CodeMirror 6 + `@codemirror/legacy-modes` (shell) + `@codemirror/theme-one-dark` |
| Build / dev server | Vite |
| Tests | `node --test` |

## Développement

```bash
npm run dev       # serveur Vite + HMR
npm run build     # build de production → dist/
npm run preview   # servir le build
npm test          # tests du moteur (25)
```

Les tests couvrent : boucles (par itération), `if`/`elif` (branche unique + condition), `while`, `$?` préservé, tableaux indexés et associatifs, `exit`, code de sortie non nul, substitution de commande sans pollution, pipelines, `printf` sans retour à la ligne, collision de marqueur, CRLF/BOM, texte des étapes (`a=1; b=2`, multi-ligne, `case`), contexte (`$0`, `$#`, `$@`, `cd`), erreurs de syntaxe, script vide, limite `maxSteps`, et exécution des 6 exemples.

## Limitations

- **Subset pédagogique** : variables, tableaux, associatifs, boucles, conditionnels, fonctions, pipelines, expansions. Certaines constructions avancées peuvent ne pas être découpées finement.
- **Fonctions atomiques** : un appel de fonction est une seule étape (on n'entre pas dans le corps) — sinon les marqueurs pollueraient les valeurs capturées par `$(...)`.
- **Subshells** : le contenu de `$(...)`, `<(...)` et `(...)` n'est pas instrumenté (pas de pas à pas à l'intérieur), pour la même raison de non-pollution.
- **Listes `&&` / `||` atomiques** : `a && b` est une étape (le découper casserait le court-circuit).
- **Pas de `read` interactif** : bashkit-wasm ne supporte pas l'entrée interactive.
- **Commandes externes** : limitées aux builtins et à l'outillage interne de bashkit.

## Licence

MIT
