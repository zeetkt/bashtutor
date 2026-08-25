# Architecture

Ce document décrit le fonctionnement interne de Bash Tutor, du script source jusqu'aux étapes affichées. Pour les conventions de contribution, voir [AGENTS.md](./AGENTS.md).

## Vue d'ensemble

```
 script source                engine.js                          UI (main.js)
 ┌──────────┐   findStepNodes   ┌─────────────────────┐          ┌──────────────┐
 │ for i …  │ ─────────────────→│ instrument(script)   │          │ renderCode   │
 │ do       │   (parser.js)     │   __bt_before/after  │          │ renderVars   │
 │  echo $i │                   │   autour de chaque    │          │ renderOutput │
 │ done     │                   │   commande            │          └──────┬───────┘
 └──────────┘                   └──────────┬──────────┘                 │
                                            │                            │
                                  1 seul executeSync(bashkit)            │
                                            │                            │
                                ┌───────────▼───────────┐                │
                                │ stdout/stderr + LOG   │                │
                                │ + BLLOG (fichiers)    │                │
                                └───────────┬───────────┘                │
                                            │                            │
                                  splitByMarkers +                       │
                                  parseAfterBlock                        │
                                            │                            │
                                            └──────────── steps[] ───────┘
```

Le cœur du défi : **bashkit-wasm n'expose pas de point d'arrêt ni d'API de lecture d'état en cours d'exécution**. `executeSync(script)` exécute tout d'un coup et renvoie `{ stdout, stderr, exitCode }`. On ne peut donc pas « avancer commande par commande » en appelant `executeSync` à chaque fois — l'état (variables, VFS) **ne persiste pas** entre deux appels `executeSync`.

La solution : **instrumenter le script** en injectant des sondes autour de chaque commande, exécuter le tout en un seul appel, puis reconstruire les étapes depuis les journaux.

## Pourquoi l'instrumentation (et pas trap/set -x)

bashkit-wasm a été sondé en détail. Voici les approches testées et leur résultat :

| Approche | Pourquoi ça échoue dans bashkit |
|---|---|
| `trap 'declare -p > f' DEBUG` | Se déclenche bien, mais `LINENO`=1 (cassé), `BASH_COMMAND` vide, et le **stdout du trap est avalé** — non capturé par `executeSync`. |
| `set -x` + `PS4='${LINENO} '` | Trace chaque commande en texte, mais **`PS4` n'est pas développé** : on obtient la chaîne littérale `${LINENO}`. |
| `BASH_XTRACEFD=3; exec 3>f` | **Ignoré** — bashkit ne gère pas la redirection de descripteur de fichier. |
| `exec >f` (redirection globale) | **Ignoré** aussi. |
| `BASH_SUBSHELL`, `BASHPID` | **Vides** — impossible de distinguer un subshell. |

Ce qui **fonctionne** :

- `printf '…' >> fichier` à l'intérieur d'une fonction (écriture par commande).
- `{ declare -p; } >> fichier` (groupe sur une seule ligne — le groupe multi-lignes provoque une erreur "parser fuel exhausted").

Conclusion : la seule voie fiable est d'injecter manuellement, à chaque commande repérée par AST, des appels de fonction qui écrivent dans des fichiers journaux et émettent des marqueurs textuels dans stdout/stderr.

## Le parser — `findStepNodes` (src/parser.js)

tree-sitter-bash produit un AST. On le parcourt pour trouver les « commandes exécutables » — les nœuds qui correspondent à une unité d'exécution atomique.

### Types de nœuds marqués (STEP_TYPES)

On marque le nœud **et on ne descend pas** dans ses enfants (il est atomique) :

| Type | Exemple | Raison |
|---|---|---|
| `command` | `echo hello`, `ls -la` | Une commande simple = une étape. |
| `variable_assignment` | `x=5`, `arr=(a b c)` | Une affectation simple = une étape. |
| `declaration_command` | `declare -A m=([k]=v)`, `export x=5` | **Atomique et crucial** : si on marquait l'enfant `variable_assignment` (qui commence au nom, après `declare -A`), la sonde s'insérerait entre `declare -A` et le nom → le tableau deviendrait indexé. |
| `pipeline` | `cmd1 \| cmd2` | Un pipeline est une étape (on ne détaille pas chaque maillon). |
| `list` | `a && b`, `a \|\| b`, `a ; b` | Une liste `&&`/`||` est une étape (préserve le court-circuit). |

### Types de nœuds sautés (SKIP_TYPES)

On **n'instrumente jamais** à l'intérieur de ces nœuds (on ne descend pas, on ne marque pas) :

| Type | Raison |
|---|---|
| `function_definition` | Le corps d'une fonction n'est exécuté qu'à l'appel. Si on l'instrumentait, `r=$(mafonction)` capturerait les marqueurs internes → `r` vaudrait `__BTM_…`. Un appel de fonction reste une étape atomique. |
| `command_substitution` | `$(…)` : idem, les marqueurs internes pollueraient la valeur capturée. |
| `process_substitution` | `<(…)` : même problème. |
| `subshell` | `( … )` : même problème. |

### Types conteneurs (ni STEP ni SKIP)

`for_statement`, `while_statement`, `if_statement`, `case_item`, `do_group`, `compound_statement`, etc. : on **descend** dedans pour trouver les commandes enfants. C'est ce qui permet à une boucle de produire une étape par itération (le corps `do_group` contient les commandes qu'on marque).

### Algorithme de parcours

```js
function walkSteps(node, out) {
  if (SKIP_TYPES.has(node.type)) return;        // ne pas descendre
  if (STEP_TYPES.has(node.type)) {              // atomique : marquer, ne pas descendre
    out.push({ startIndex, endIndex, startLine, endLine, type });
    return;
  }
  for (const c of node.namedChildren) walkSteps(c, out);  // conteneur : descendre
}
```

### Détection d'erreurs — `firstErrorLine`

Si `root.hasError`, on parcourt l'arbre à la recherche des nœuds `ERROR` ou manquants, on trie par ligne, et on renvoie la première ligne d'erreur. Le moteur court-circuite alors (pas d'exécution) et l'UI affiche l'erreur.

## Le moteur — instrumentation (src/engine.js)

### Constantes

| Nom | Valeur | Rôle |
|---|---|---|
| `MARK` | `__BTM_9F3K__` | Préfixe des marqueurs dans stdout/stderr (suffisamment unique pour ne pas collisionner avec du contenu utilisateur). |
| `LOG` | `/tmp/__bt_log_9F3K.log` | Fichier des instantanés de variables (un bloc par commande). |
| `BLLOG` | `/tmp/__bt_bl_9F3K.log` | Fichier des numéros de ligne (un par commande, car `LINENO` est cassé dans bashkit). |
| `END` | `END` | Marqueur trailing (fin normale du script). |
| `TRUNC` | `TRUNC` | Marqueur de tronquage (limite `maxSteps` atteinte). |

### `collectArrayNames`

Avant l'instrumentation, on scanne le texte de chaque étape pour trouver les noms de tableaux/associatifs déclarés ou affectés (regex sur `name=(`), `name[`, `mapfile`, `read -a`, `declare -A`). Ces noms seront passés à la sonde `__bt_after` pour qu'elle émette `declare -p <nom>` en plus de `declare -p` (bare) — sinon les tableaux ne seraient pas capturés.

### `buildPrologue`

Génère le préfixe qui définit les deux fonctions sonde :

```bash
__bt_before() {
  __bt_count=$(( __bt_count + 1 ))
  if [ "$__bt_count" -gt '200' ]; then        # garde anti-dépassement
    printf '__BTM_9F3K__TRUNC\n'
    printf '__BTM_9F3K__TRUNC\n' >&2
    printf 'TRUNC\n' >> '/tmp/__bt_bl_9F3K.log'
    exit 0                                    # stoppe l'exécution
  fi
  printf '%s\n' "$1" >> '/tmp/__bt_bl_9F3K.log'   # journalise la ligne
}
__bt_after() {
  __bt_prev=$?                                # code de sortie de la commande précédente
  printf '__BTM_9F3K__%s\n' "$1"               # marqueur stdout (segmentation de sortie)
  printf '__BTM_9F3K__%s\n' "$1" >&2           # marqueur stderr
  printf 'M|%s|%s|%s|%s|%s|%s\n' "$1" "$__bt_prev" "$0" "$#" "$*" "$PWD" >> '/tmp/__bt_log_9F3K.log'
  { declare -p; } >> '/tmp/__bt_log_9F3K.log' 2>> '/tmp/__bt_log_9F3K.log'  # scalaires
  for __bt_n in <noms tableaux>; do declare -p "$__bt_n" >> '/tmp/__bt_log_9F3K.log' 2>> '/tmp/__bt_log_9F3K.log'; done  # tableaux
  printf '___\n' >> '/tmp/__bt_log_9F3K.log'   # séparateur de bloc
}
__bt_count=0
: > '/tmp/__bt_log_9F3K.log'                  # vide les journaux au départ
: > '/tmp/__bt_bl_9F3K.log'
```

### `instrument`

Insère `__bt_before L; ` avant et `; __bt_after L` après chaque nœud-étape (où `L` = numéro de ligne, hardcodé depuis l'AST — aucune dépendance à `LINENO`).

```text
  echo "x=$i"
  devient
  __bt_before 5; echo "x=$i"; __bt_after 5
```

Les insertions se font par offset, **en partant de la fin** (tri par `startIndex` décroissant) pour ne pas invalider les offsets précédents.

Détail : le `; __bt_after L` (sans `; ` final) évite un double-point-virgule quand la commande est suivie d'un `;` dans la source (sinon `;;` ou `; ;`).

### Script final

```
prologue + script instrumenté + "\n__bt_after END\n"
```

Le marqueur `__bt_after END` trailing indique une fin **normale**. Si le script appelle `exit`, ce marqueur n'est pas émis — c'est ce qui permet de détecter l'exit (voir plus bas).

## Le moteur — exécution et reconstruction

### Exécution

Un seul appel : `bash.executeSync(full)`. On récupère :

- `res.stdout` / `res.stderr` : contiennent les marqueurs et la sortie réelle.
- `bash.readFile(LOG)` : le journal des instantanés de variables.
- `bash.readFile(BLLOG)` : le journal des numéros de ligne.
- `res.exitCode` : code de sortie global.

### Découpage

1. **`splitByMarkers(stdout)`** — découpe stdout en segments séparés par les lignes `__BTM_9F3K__<marker>`. Chaque segment = sortie d'une commande. La sortie **avant** le premier marqueur (qui n'existe normalement pas car `__bt_before` précède chaque commande) est incluse via `push` à chaque marqueur rencontré.

2. **`parseAfterBlock`** — pour chaque bloc du LOG (séparés par `___\n`) :
   - Ligne d'en-tête `M|<line>|<exit>|<argv0>|<argc>|<argv>|<cwd>`.
   - Lignes `declare …` (scalaires + tableaux).
   - Construction de l'objet `{ line, exit, ctx, vars }` via `parseDeclareP` + `filterUserVars`.

3. **Appariement direct** : l'étape *k* = bloc *k* (état après la commande *k*) = segment stdout *k* (sortie de la commande *k*). C'est possible parce que `__bt_after` émet le marqueur **après** la commande, donc le segment *k* contient la sortie produite entre le marqueur *k-1* et le marqueur *k*.

### Cas particulier : `exit`

Si le script appelle `exit N`, le marqueur `__bt_after END` n'est pas émis (l'exécution s'arrête avant). On détecte alors l'absence de `END` (et de `TRUNC`) et on **synthétise** une étape finale :

- La ligne vient du fichier BLLOG (l'entrée correspondant à la commande `exit` — `__bt_before` a eu le temps de journaliser la ligne avant l'exit).
- Le code de sortie vient de `res.exitCode`.
- Les variables/ctx viennent du dernier bloc capturé (avant l'exit).

### Tronquage

Si `maxSteps` est atteint, `__bt_before` émet le marqueur `TRUNC` et appelle `exit 0`. `runScript` renvoie `truncated: true` et l'UI affiche une bannière d'avertissement.

## Le parsing des variables (src/vars.js)

### `parseDeclareP`

`declare -p` produit des lignes comme :

```
declare -- x="5"
declare -a arr=("a" "b" "c")
declare -A m=([k]="v" [w]="z")
declare -ir n="42"
```

On parse chaque ligne :

- Flags : `--` (rien), `-a` (tableau indexé), `-A` (associatif), `-i` (entier), `-r` (readonly), `-x` (exporté).
- Valeur :
  - **string** : décodage des échappements (`\"`, `\n`, `\xNN`, `\uNNNN`…).
  - **array** : paires `[index]="valeur"` triées par index numérique.
  - **assoc** : paires `[clé]="valeur"` (non triées, ordre d'insertion).

### Filtrage

`isSystemVar` exclut : la liste `SYSTEM_VARS` (EUID, PATH, BASH_VERSION, …), tout préfixe `BASH`, `COMP_`, et `__bt` (les variables de sonde). `filterUserVars` applique ce filtre au résultat final.

## L'UI (src/main.js + src/ui/)

### Cycle de rendu

```
run(code) → runScript(code) → { steps, truncated, error? }
                                          │
                            state.steps = steps; state.idx = 0
                                          │
                                      render()
                                          │
              ┌───────────────┬───────────┴───────────┬──────────────────┐
              ▼               ▼                       ▼                  ▼
        renderCode      renderVariables         renderContext       renderOutput
   (surligne ligne)   (diff vs étape N-1)    ($PWD, $0, $?, …)   (chunks stdout/stderr)
```

### Diff de variables (src/diff.js)

`computeVarDiff(prevVars, nextVars)` compare les signatures `JSON.stringify([kind, value])` pour classer les variables en `added` / `changed` / `removed`. Les classes CSS `added` (vert) / `changed` (jaune) / `removed` (rouge barré) sont appliquées dans `renderVariables`.

### Code view

`renderCode` génère un `<div class="line">` par ligne, avec `.current` sur la/les ligne(s) de l'étape. Auto-scroll centré. `renderCurrentStmt` affiche le texte de la commande courante dans une bande en bas du panneau.

### Contrôles (src/ui/controls.js)

Navigation : premier / précédent / suivant / dernier + lecture auto (setTimeout récursif avec vitesse réglable). Le compteur `N / total` et la désactivation des boutons aux extrémités sont gérés par `setSteps`.

### Navigation clavier

`ArrowLeft` / `ArrowRight` appellent `goBack` / `goNext`, sauf si le focus est dans l'éditeur CodeMirror (`.cm-content`) — pour ne pas interférer avec l'édition.

## Diagramme de flux de données complet

```
┌─────────────────────────────────────────────────────────────────────┐
│ 1. PARSER                                                           │
│    script → tree-sitter → AST → findStepNodes → steps[] (offsets)   │
│    + firstErrorLine (si syntax error → return tôt)                  │
├─────────────────────────────────────────────────────────────────────┤
│ 2. INSTRUMENT                                                       │
│    collectArrayNames(steps) → noms de tableaux                      │
│    buildPrologue(maxSteps, noms) → définition des sondes            │
│    instrument(script, steps) → script avec __bt_before/after        │
│    full = prologue + instrumenté + "\n__bt_after END\n"             │
├─────────────────────────────────────────────────────────────────────┤
│ 3. EXECUTE                                                          │
│    bash.executeSync(full) → { stdout, stderr, exitCode }           │
│    bash.readFile(LOG) → logContent (blocs séparés par ___)         │
│    bash.readFile(BLLOG) → blContent (lignes)                      │
├─────────────────────────────────────────────────────────────────────┤
│ 4. RECONSTRUCT                                                      │
│    splitByMarkers(stdout) → outSegs (segments par commande)        │
│    splitByMarkers(stderr) → errSegs                                 │
│    logContent.split("___\n").map(parseAfterBlock) → afterBlocks    │
│    afterBlocks.filter(line !== null) → cmdBlocks (état par étape)   │
│    blContent.split("\n") → blLines (ligne par commande)           │
├─────────────────────────────────────────────────────────────────────┤
│ 5. PAIR                                                             │
│    for k in 0..cmdBlocks.length:                                    │
│      step[k] = {                                                    │
│        line: cmdBlocks[k].line,                                     │
│        vars: cmdBlocks[k].vars,  (état APRÈS commande k)           │
│        stdout: outSegs[k].text,  (sortie DE commande k)            │
│        stderr: errSegs[k].text,                                     │
│        exitCode: cmdBlocks[k].exit,                                 │
│        text: sourceLines[line],                                     │
│        cumulativeStdout: cumul, ...                                 │
│      }                                                              │
├─────────────────────────────────────────────────────────────────────┤
│ 6. EXIT HANDLING                                                    │
│    if !hasEnd && !hasTrunc:                                         │
│      synthétise étape finale depuis blLines[k] + execExit           │
├─────────────────────────────────────────────────────────────────────┤
│ 7. RETURN                                                           │
│    { steps: result, truncated: hasTrunc }                           │
└─────────────────────────────────────────────────────────────────────┘
```

## Limites assumées

- **Fonctions atomiques** : un appel `mafonction args` est une étape (le corps n'est pas détaillé). Sinon `r=$(mafonction)` polluerait `r` avec les marqueurs.
- **Subshells non instrumentés** : `$(…)`, `<(…)`, `( … )` ne produisent pas de pas à pas interne.
- **Pas de `read` interactif** : bashkit ne gère pas l'entrée interactive.
- **Commandes externes** : limitées aux builtins de bashkit. `cat`, `sort`, `tr`, `grep`, `wc`, `seq`, `mapfile` fonctionnent car implémentés dans bashkit ; d'autres binaires externes peuvent ne pas être disponibles.
