# Bash Tutor

Visualiseur d'exécution Bash pas à pas, façon [Python Tutor](https://pythontutor.com/). 100 % côté navigateur : aucun serveur, aucune exécution réelle sur ta machine. Un moteur Bash virtuel (WASM) simule le script et l'interface affiche, à **chaque commande exécutée**, les variables, le contexte et la sortie produite.

> Une boucle `for` produit **une étape par itération**. Un `if` ne montre **que la branche exécutée**. Tu vois les variables changer en temps réel, comme si tu déboguais ligne par ligne.

## Aperçu

```
┌──────────────────────────────────────────────────────────────┐
│  Bash Tutor        [Exemple ▾]   [Visualiser]   Moteur prêt ✓ │
├───────────────────┬───────────────────┬──────────────────────┤
│  Script Bash      │ Exécution pas à   │  Variables / Contexte│
│  (éditeur         │ pas (ligne        │  / Sortie             │
│   CodeMirror)     │  courante         │  (onglets)            │
│                   │  surlignée)       │                       │
├───────────────────┴───────────────────┴──────────────────────┤
│  🐈‍⬛ ◀  3 / 13 ▶ 🐢     [Lecture]  Vitesse: [normale ▾]    │
└──────────────────────────────────────────────────────────────┘
```

## Fonctionnalités

- **Pas à pas commande par commande** — pas statement par statement. Les itérations de boucles et les branches de conditionnelles deviennent des étapes distinctes.
- **État après chaque commande** — variables scalaires, tableaux indexés, tableaux associatifs, flags (`readonly`, `export`), répertoire courant, code de sortie (`$?`).
- **Diff visuel** — les variables ajoutées / modifiées / supprimées entre deux étapes sont colorées.
- **Sortie segmentée** — stdout et stderr de chaque étape affichés séparément, avec mise en évidence de l'étape courante.
- **Détection d'erreurs** — les erreurs de syntaxe sont localisées (ligne soulignée) avant exécution ; les erreurs d'exécution sont signalées.
- **Limite de sécurité** — un script trop long (boucle infinie, etc.) est tronqué après 200 commandes et l'UI le signale.
- **Lecture automatique** avec réglage de vitesse, navigation clavier (← →).
- **6 exemples pédagogiques** intégrés : somme, tableaux, associatifs, fonctions, pipelines, conditions.

## Démarrage rapide

```powershell
git clone https://github.com/zeetkt/bashtutor.git
cd bashtutor
npm install
npm run dev      # http://localhost:5173
```

Pré-requis : Node.js 18+ et un navigateur récent (Chrome, Firefox, Edge).

## Utilisation

1. Choisir un exemple dans la liste déroulante, ou éditer le script directement dans l'éditeur.
2. Cliquer sur **Visualiser l'exécution**.
3. Naviguer entre les étapes avec ⏮ ◀ ▶ ⏭, le bouton **Lecture**, ou les flèches ← → du clavier (l'éditeur en focus ignore les flèches pour ne pas interférer).

Le panneau de droite affiche, pour l'étape courante (onglets) :

| Onglet | Contenu |
|---|---|
| **Variables** | Variables définies, avec coloration des ajouts / modifications / suppressions par rapport à l'étape précédente. |
| **Contexte** | `$PWD`, `$0`, `$#`, `$@`, `$?`, succès. |
| **Sortie** | stdout / stderr de chaque étape (l'étape courante est surlignée et auto-scrollée). |

## Comment ça marche (en bref)

bashkit-wasm ne permet pas d'interrompre l'exécution ni de lire l'état interne en cours de run. Bash Tutor contourne cela par une **instrumentation du script** :

1. Le script est analysé avec tree-sitter pour localiser chaque commande exécutable.
2. Des sondes (`__bt_before` / `__bt_after`) sont injectées autour de chaque commande.
3. Le script instrumenté est exécuté en **un seul appel** `executeSync`.
4. Les journaux et marqueurs produits sont découpés et reconstruits en étapes (lignes, variables, sortie).

👉 Le détail complet (AST, types de nœuds, flux de données, contraintes bashkit) est dans [ARCHITECTURE.md](./ARCHITECTURE.md).

## Structure du projet

```
bashtutor/
├── index.html              # structure de la page (header + grille 3-panneaux + contrôles)
├── style.css               # thème clair, layout grid, classes de diff
├── package.json            # scripts : dev / build / preview / test
├── public/                 # assets WASM servis tels quels
│   ├── bashkit.wasm        # moteur Bash virtuel (Rust → WASM)
│   ├── tree-sitter-bash.wasm  # grammaire tree-sitter
│   └── web-tree-sitter.wasm   # runtime tree-sitter (core)
├── examples/               # 6 scripts pédagogiques (.sh, importés en ?raw)
│   ├── 01-somme.sh
│   ├── 02-tableaux.sh
│   ├── 03-associatifs.sh
│   ├── 04-fonctions.sh
│   ├── 05-pipelines.sh
│   └── 06-conditions.sh
├── src/
│   ├── engine.js           # instrumentation + exécution + reconstruction des étapes
│   ├── parser.js           # tree-sitter : findStepNodes, firstErrorLine
│   ├── vars.js             # parse declare -p (scalaires, tableaux, associatifs)
│   ├── diff.js             # computeVarDiff (ajouts / modifs / suppressions)
│   ├── examples.js         # import des 6 exemples
│   ├── main.js             # orchestration UI + moteur
│   └── ui/
│       ├── editor.js       # CodeMirror 6 (coloration shell)
│       ├── codeview.js     # rendu du script + surlignage ligne courante
│       ├── panels.js       # Variables / Contexte / Sortie
│       └── controls.js     # navigation + lecture auto
└── tests/
    └── engine.test.mjs     # 12 tests (node:test)
```

## Stack technique

| Rôle | Technologie |
|---|---|
| Moteur Bash virtuel | [`@everruns/bashkit-wasm`](https://www.npmjs.com/package/@everruns/bashkit-wasm) (Rust → WASM, exécuté en navigateur) |
| Analyse syntaxique | `web-tree-sitter` + `tree-sitter-bash` |
| Éditeur | CodeMirror 6 + `@codemirror/legacy-modes` (shell) |
| Build / dev server | Vite |
| Tests | `node --test` |

## Développement

```powershell
npm run dev       # serveur Vite + HMR
npm run build     # build de production → dist/
npm run preview   # servir le build
npm test          # tests du moteur
```

Les tests couvrent : boucles (par itération), `if` (branche unique), `while`, tableaux indexés et associatifs, `exit`, code de sortie non nul (`false`), substitution de commande sans pollution, pipelines, erreurs de syntaxe, script vide, limite `maxSteps`, contexte (`cd`).

## Limitations

- **Subset pédagogique** : variables, tableaux, associatifs, boucles, conditionnels, fonctions, pipelines, expansions. Certaines constructions avancées peuvent ne pas être découpées finement.
- **Fonctions atomiques** : un appel de fonction est une seule étape (on n'entre pas dans le corps) — sinon les marqueurs pollueraient les valeurs capturées par `$(...)`.
- **Subshells** : le contenu de `$(...)`, `<(...)` et `(...)` n'est pas instrumenté (pas de pas à pas à l'intérieur), pour la même raison de non-pollution.
- **Pas de `read` interactif** : bashkit-wasm ne supporte pas l'entrée interactive.
- **Commandes externes** : limitées aux builtins et à l'outillage interne de bashkit.

## Licence

MIT
