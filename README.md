# Bash Tutor

Visualiseur d'exécution Bash pas à pas, 100 % côté navigateur. Aucun serveur, aucune exécution réelle : un moteur Bash virtuel (WASM) simule le script et affiche, à chaque étape, les variables, le contexte d'appel et la sortie produite.

## Lancement

```powershell
npm install
npm run dev      # serveur de développement (http://localhost:5173)
npm run build    # build de production dans dist/
npm run preview  # prévisualiser le build
npm test         # tests du moteur (node --test)
```

## Utilisation

1. Choisir un exemple dans la liste déroulante (ou éditer le script dans l'éditeur).
2. Cliquer sur **Visualiser l'exécution**.
3. Naviguer entre les étapes avec les boutons ⏮ ◀ ▶ ⏭, la lecture automatique, ou les flèches ← → du clavier (l'éditeur en focus ignore les flèches).

Le panneau de droite affiche, pour l'étape courante :
- **Variables** : variables définies (avec coloration des ajouts / modifications / suppressions par rapport à l'étape précédente).
- **Contexte** : répertoire courant, nom du script, arguments.
- **Sortie** : ce que l'étape a écrit sur stdout/stderr (l'étape courante est surlignée).

## Architecture

| Fichier | Rôle |
|---|---|
| `src/engine.js` | Cœur du simulateur. Instrumente le script (injection de sondes autour de chaque commande via l'AST), exécute le tout en un appel `executeSync` de `@everruns/bashkit-wasm`, puis reconstruit les étapes (lignes, variables, sortie) depuis les journaux et marqueurs. |
| `src/parser.js` | Analyse syntaxique avec `web-tree-sitter` + `tree-sitter-bash`. Localise chaque commande exécutable (`findStepNodes`) et détecte les erreurs de syntaxe. |
| `src/vars.js` | Analyse de `declare -p` pour reconstruire variables scalaires, tableaux, tableaux associatifs (avec flags readonly/exporté). |
| `src/ui/editor.js` | Éditeur CodeMirror 6 (coloration shell via `@codemirror/legacy-modes`). |
| `src/ui/codeview.js` | Rendu du script avec numéros de ligne et surlignage de l'instruction courante. |
| `src/ui/panels.js` | Panneaux Variables / Contexte / Sortie. |
| `src/ui/controls.js` | Barre de navigation (premier/précédent/suivant/dernier, lecture auto, vitesse). |
| `src/main.js` | Orchestration : init du moteur, câblage de l'UI, rendu. |
| `examples/*.sh` | Exemples pédagogiques. |

### Granularité du pas à pas

Le pas à pas se fait **au niveau de chaque commande exécutée** (command-level), comme Python Tutor. Une boucle `for` produit **une étape par itération** ; un `if` ne montre que la branche exécutée. Les branches non atteintes et les itérations non exécutées ne génèrent pas d'étapes.

### Stratégie d'extraction de l'état (instrumentation)

bashkit-wasm n'expose pas d'API directe pour lire l'état interne, ni de mécanisme fiable pour interrompre l'exécution (`trap DEBUG` déclenche mais son stdout est avalé ; `LINENO`/`BASH_COMMAND`/`BASH_SUBSHELL`/`BASHPID` sont vides dans bashkit ; `exec >f` et `BASH_XTRACEFD` sont ignorés).

L'engine utilise donc une **instrumentation par AST** : `findStepNodes` (tree-sitter) localise chaque « commande exécutable » (nœuds `command`, `variable_assignment`, `declaration_command`, `pipeline`, `list`), en répérant les corps de boucles/conditions mais en **sautant** les définitions de fonctions, subshells `()` et substitutions `$(...)` (pour éviter que les sondes ne polluent les valeurs capturées). Le script est alors récrit en injectant autour de chaque commande :

- un `__bt_before L` (avant) : compteur d'étapes + garde anti-dépassement (`maxSteps`) + journalisation du n° de ligne ;
- un `__bt_after L` (après) : capture de `$?`, de `declare -p` (scalaires + tableaux/associatifs nommés) vers un fichier **log**, et émission d'un marqueur vers stdout+stderr pour segmenter la sortie par commande.

Le tout est exécuté en **un seul** `executeSync`. Les résultats sont ensuite reconstruits : le fichier BL donne les lignes (y compris celle d'un `exit`), le fichier log donne les instantanés de variables, et les marqueurs dans stdout/stderr découpent la sortie par commande. L'état affiché à l'étape *N* est l'état **après** l'exécution de la commande *N* (immédiatement, avant toute avance de boucle).

## Limitations

- **Subset pédagogique** : variables, tableaux, tableaux associatifs, boucles, conditionnels, pipelines, expansions. Certaines constructions avancées peuvent ne pas être découpées finement.
- **Fonctions atomiques** : un appel de fonction est une seule étape (on n'entre pas dans le corps) — sinon les marqueurs pollueraient les valeurs capturées par `$(...)`. Un `for`/`while`/`if` à l'intérieur d'une fonction n'est donc pas détaillé pas à pas.
- **Subshells** : le contenu de `$(...)`, `<(...)` et `(...)` n'est pas instrumenté (pas de pas à pas à l'intérieur), pour la même raison de non-pollution.
- **Pas de `read` interactif** : bashkit-wasm ne supporte pas l'entrée interactive.
- **Commandes externes** : limitées aux builtins et à l'outillage interne de bashkit.

## Dépendances

- `@everruns/bashkit-wasm` — moteur Bash virtuel (Rust → WASM)
- `web-tree-sitter` + `tree-sitter-bash` — analyse syntaxique
- `codemirror` + `@codemirror/legacy-modes` — éditeur
- `vite` — bundler / serveur de dev
