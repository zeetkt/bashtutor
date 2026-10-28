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
                                  parseStream + parseAfterBlock          │
                                            │                            │
                                            └──────────── steps[] ───────┘
```

Le cœur du défi : **bashkit-wasm n'expose pas de point d'arrêt ni d'API de lecture d'état en cours d'exécution**. `executeSync(script)` exécute tout d'un coup et renvoie `{ stdout, stderr, exitCode }`. On ne peut donc pas « avancer commande par commande » en appelant `executeSync` à chaque fois — l'état (variables, VFS) **ne persiste pas** entre deux appels.

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

Chaque nœud retenu reçoit un **`id`** (son rang dans le parcours, en ordre de document) et un **`kind`** (`command` ou `condition`). Le moteur ne transmet que cet `id` au script instrumenté : le texte et les bornes de lignes sont relus depuis l'AST au moment de la reconstruction, ce qui garantit un libellé exact même pour `a=1; b=2`, une commande multi-ligne ou un `for …; do …; done` sur une ligne.

### Types de nœuds marqués (STEP_TYPES)

On marque le nœud **et on ne descend pas** dans ses enfants (il est atomique) :

| Type | Exemple | Raison |
|---|---|---|
| `command` | `echo hello`, `ls -la` | Une commande simple = une étape. |
| `variable_assignment` | `x=5`, `arr=(a b c)` | Une affectation simple = une étape. |
| `declaration_command` | `declare -A m=([k]=v)`, `export x=5` | **Atomique et crucial** : si on marquait l'enfant `variable_assignment` (qui commence au nom, après `declare -A`), la sonde s'insérerait entre `declare -A` et le nom → le tableau deviendrait indexé. |
| `pipeline` | `cmd1 \| cmd2` | Un pipeline est une étape (on ne détaille pas chaque maillon). |
| `list` | `a && b`, `a \|\| b` | Une liste `&&`/`||` est une étape (préserve le court-circuit ; la découper casserait la sémantique). |

### Conditions (CONDITION_PARENTS)

Les conditions de `if` / `elif` / `while` / `until` produisent une étape de type `condition` (affichée « vraie » ou « fausse » dans l'UI) :

| Parent | Condition retenue |
|---|---|
| `if_statement` | champ `condition` |
| `while_statement` (aussi `until`) | champ `condition` |
| `elif_clause` | **pas de champ** : on prend le premier enfant nommé (`elif` n'est pas un nœud nommé) |

On saute ensuite la condition dans la boucle d'enfants pour ne pas la marquer deux fois.

### Types de nœuds sautés (SKIP_TYPES)

On **n'instrumente jamais** à l'intérieur de ces nœuds (on ne descend pas, on ne marque pas) :

| Type | Raison |
|---|---|
| `function_definition` | Le corps d'une fonction n'est exécuté qu'à l'appel. Si on l'instrumentait, `r=$(mafonction)` capturerait les marqueurs internes. Un appel de fonction reste une étape atomique. |
| `command_substitution` | `$(…)` : idem, les marqueurs internes pollueraient la valeur capturée. |
| `process_substitution` | `<(…)` : même problème. |
| `subshell` | `( … )` : même problème. |

### Types conteneurs (ni STEP ni SKIP)

`for_statement`, `case_item`, `do_group`, `compound_statement`, etc. : on **descend** dedans pour trouver les commandes enfants. C'est ce qui permet à une boucle de produire une étape par itération.

### Algorithme de parcours

```js
function walkSteps(node, out) {
  if (SKIP_TYPES.has(node.type)) return;
  if (CONDITION_PARENTS.has(node.type)) {
    const condition = conditionNode(node);
    if (condition) out.push(stepNode(condition, "condition"));
    for (const child of node.namedChildren) {
      if (child.equals(condition)) continue;
      walkSteps(child, out);
    }
    return;
  }
  if (STEP_TYPES.has(node.type)) {
    out.push(stepNode(node, "command"));
    return;
  }
  for (const child of node.namedChildren) walkSteps(child, out);
}
```

### Détection d'erreurs — `firstErrorLine`

Si `root.hasError`, on parcourt l'arbre à la recherche des nœuds `ERROR` ou manquants, on trie par ligne, et on renvoie la première ligne d'erreur. Le moteur court-circuite alors (pas d'exécution) et l'UI surligne cette ligne dans l'éditeur et dans la trace.

## Le moteur — instrumentation (src/engine.js)

### Constantes

| Nom | Valeur | Rôle |
|---|---|---|
| `SEP` | `\x1e` (0x1E) | Préfixe de marqueur dans stdout/stderr. Non imprimable, quasi impossible à produire par accident. |
| jeton | 16 hexadécimaux aléatoires par exécution | Empêche toute collision avec la sortie utilisateur. |
| `LOG` | `/tmp/__bt_log_9F3K.log` | Instantanés de variables (un bloc par commande). |
| `BLLOG` | `/tmp/__bt_bl_9F3K.log` | Ordre d'exécution : `B\|<seq>\|<id>` ; `T` en cas de troncature. |
| `END` | `END` | Marqueur trailing (fin normale du script). |
| `TRUNC` | `TRUNC` | Marqueur de tronquage (limite `maxSteps` atteinte). |

`normalizeScript` retire le BOM et convertit les fins de ligne CRLF/CR en LF **avant** l'analyse : sans cela, un script récupéré sur Windows (`for …; do\r`) fait échouer le parseur de bashkit.

### `collectArrayNames`

Avant l'instrumentation, on scanne le texte de chaque étape pour trouver les noms de tableaux/associatifs déclarés ou affectés (regex sur `name=(`), `name[`, `mapfile`, `read -a`, `declare -A`). Ces noms sont passés à `__bt_after` pour qu'elle émette `declare -p <nom>` en plus de `declare -p` (bare) — sinon `declare -p` seul ne liste que les scalaires.

### `buildPrologue`

Génère le préfixe qui définit les deux fonctions sonde. Points importants :

- `__bt_before` mémorise `$?` (`__bt_in`) et le **restitue** (`return $__bt_in`). Sans cela, la sonde écraserait le code de sortie et `if grep …; then` prendrait toujours la branche `then`.
- `__bt_after` mémorise `$?` en premier, puis **le restitue** (`return $__bt_prev`).
- Les marqueurs sont `\x1e<jeton>:<seq>:<id>` et sont émis sur stdout **et** stderr.
- `$0`, `$#`, `$*` sont **reçus en arguments depuis le site d'appel** : dans bashkit, un appel de fonction met `$0` au nom de la fonction et `$#`/`$*` à ses arguments. Les lire dans la sonde donnerait `__bt_after|1|<id>`.

```bash
__bt_before() {
  __bt_in=$?
  __bt_count=$(( __bt_count + 1 ))
  __bt_seq=$(( __bt_seq + 1 ))
  if [ "$__bt_count" -gt '200' ]; then
    printf '\036<jeton>:TRUNC:TRUNC\n'
    printf '\036<jeton>:TRUNC:TRUNC\n' >&2
    printf 'T\n' >> '/tmp/__bt_bl_9F3K.log'
    exit 0
  fi
  printf 'B|%s|%s\n' "$__bt_seq" "$1" >> '/tmp/__bt_bl_9F3K.log'
  return $__bt_in
}
__bt_after() {
  __bt_prev=$?
  printf '\036<jeton>:%s:%s\n' "$__bt_seq" "$1"
  printf '\036<jeton>:%s:%s\n' "$__bt_seq" "$1" >&2
  printf 'M|%s|%s|%s|%s|%s|%s|%s\n' "$__bt_seq" "$1" "$__bt_prev" "$2" "$3" "$PWD" "$4" >> '/tmp/__bt_log_9F3K.log'
  { declare -p; } >> '/tmp/__bt_log_9F3K.log' 2>> '/tmp/__bt_log_9F3K.log'
  for __bt_n in <noms tableaux>; do declare -p "$__bt_n" >> '/tmp/__bt_log_9F3K.log' 2>> '/tmp/__bt_log_9F3K.log'; done
  printf '___\n' >> '/tmp/__bt_log_9F3K.log'
  return $__bt_prev
}
__bt_count=0
__bt_seq=0
: > '/tmp/__bt_log_9F3K.log'
: > '/tmp/__bt_bl_9F3K.log'
```

### `instrument`

Insère `__bt_before <id>; ` avant et `; __bt_after <id> "$0" "$#" "$*"` après chaque nœud-étape. Aucun numéro de ligne n'est codé en dur : l'`id` renvoie au nœud AST, dont on relit `text`, `startLine` et `endLine`.

```text
  echo "x=$i"
  devient
  __bt_before 5; echo "x=$i"; __bt_after 5 "$0" "$#" "$*"
```

Les insertions se font par offset, **en partant de la fin** (tri par `startIndex` décroissant) pour ne pas invalider les offsets précédents.

Détail : le `; __bt_after …` (sans `; ` final) évite un double-point-virgule quand la commande est suivie d'un `;` dans la source (sinon `;;` ou `; ;`).

### Script final

```
prologue + script instrumenté + "\n__bt_after END \"$0\" \"$#\" \"$*\"\n"
```

Le marqueur `END` trailing indique une fin **normale**. Si le script appelle `exit` (ou `exec`), ce marqueur n'est pas émis — c'est ce qui permet de détecter l'arrêt.

## Le moteur — exécution et reconstruction

### Exécution

Un seul appel : `bash.executeSync(full)`. On récupère :

- `res.stdout` / `res.stderr` : contiennent les marqueurs et la sortie réelle.
- `bash.readFile(LOG)` : le journal des instantanés de variables.
- `bash.readFile(BLLOG)` : l'ordre d'exécution et les ids de nœuds.
- `res.exitCode` : code de sortie global.

### Découpage des sorties — `parseStream`

On cherche `\x1e<jeton>:` dans le flux. Le marqueur est émis **après** la commande : le texte compris entre le marqueur précédent et le marqueur courant est donc la sortie de la commande qui vient de se terminer. On le conserve **tel quel** (aucun `\n` ajouté), ce qui restitue exactement `printf "abc"` sans retour à la ligne. Les marqueurs `END` et `TRUNC` ne créent pas de segment ; le texte après le dernier marqueur (`tail`) appartient à une éventuelle commande interrompue.

### Journal des états — `parseAfterBlock`

Chaque bloc du LOG (séparés par `___\n`) contient :

- une ligne `M|<seq>|<id>|<exit>|<argv0>|<argc>|<cwd>|<argv>` (`argv` en dernier pour pouvoir contenir des `|`) ;
- des lignes `declare …` (scalaires + tableaux).

On construit `{ seq, id, exit, ctx, vars }` via `parseDeclareP` + `filterUserVars`.

### Reconstruction

1. `parseBeforeLog(BLLOG)` donne la suite ordonnée `{ seq, id }` des commandes réellement exécutées (y compris celle qui a provoqué un `exit`).
2. `blockBySeq`, `outBySeq`, `errBySeq` indexent blocs et segments par `seq`.
3. `metaById` associe chaque `id` au nœud AST (texte, lignes).
4. On itère sur l'ordre : `step = { text, startLine, endLine, kind, stdout, stderr, exitCode, vars, ctx, … }`.

L'utilisation de `seq` (et non de l'index du tableau) est ce qui rend l'appariement fiable même quand une boucle réexécute le même nœud.

### Cas particulier : `exit` / `exec`

Si une entrée de BLLOG n'a **pas** de bloc LOG correspondant, la commande a interrompu le shell. On synthétise l'étape finale :

- `text` / lignes viennent du nœud AST (via l'id) ;
- le code de sortie vient de `res.exitCode` ;
- les variables/contexte viennent de la dernière étape complète ;
- `stdout`/`stderr` viennent du `tail` du flux.

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
declare -- t=$'a\tb'
```

On parse chaque ligne :

- Flags : `--` (rien), `-a` (tableau indexé), `-A` (associatif), `-i` (entier), `-r` (readonly), `-x` (exporté).
- Valeur :
  - **string** : décodage des échappements (`\"`, `\n`, `\xNN`, `\uNNNN`…), y compris la forme ANSI-C `$'…'`.
  - **array** : paires `[index]="valeur"` triées par index numérique (tableau vide → `[]`).
  - **assoc** : paires `[clé]="valeur"` (ordre d'insertion).
  - déclaration sans `=` : valeur vide.

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
   (ligne courante +   (diff vs étape N-1)    ($PWD, $0, $?, …)   (chunks stdout/stderr)
    lignes cliquables)
```

`render()` met aussi à jour la barre d'explication (`renderExplanation`) et surligne la ligne courante **dans l'éditeur CodeMirror** (`highlightLines`, décorations `cm-current-line` / `cm-error-line`).

### Diff de variables (src/diff.js)

`computeVarDiff(prevVars, nextVars)` compare les signatures `JSON.stringify([kind, value])` pour classer les variables en `added` / `changed` / `removed`. Les classes CSS `added` (vert) / `changed` (jaune) / `removed` (rouge) sont appliquées dans `renderVariables`.

`renderExplanation` réutilise ce diff pour produire une phrase courte (« `somme` : "0" → "1" », « condition vraie »).

### Code view

`renderCode` génère un `<div class="line">` par ligne et met la classe `.current` sur la plage `startLine..endLine` de l'étape. Le rendu est mis en cache par script (`container.dataset.script`) : la navigation ne reconstruit pas le DOM. Seuls les numéros de ligne correspondant à une étape sont cliquables (saut direct).

### Contrôles (src/ui/controls.js)

Navigation : premier / précédent / suivant / dernier, curseur (`input[type=range]`), lecture auto (setTimeout récursif avec vitesse réglable). Le compteur `N / total` et la désactivation des boutons aux extrémités sont gérés par `setSteps`.

### Navigation clavier

- `←` / `→` : étape précédente / suivante.
- `Début` / `Fin` : première / dernière étape.
- `Échap` : arrête la lecture.
- `Ctrl+Entrée` / `Cmd+Entrée` : relance l'exécution.
- Dans l'éditeur ou un champ, les flèches gardent leur rôle d'édition.

### Thème, permalien, persistance

- Thème clair/sombre : `data-theme` sur `<html>`, mémorisé dans `localStorage` (`bashtutor.theme`) ; CodeMirror bascule via `@codemirror/theme-one-dark`.
- Permalien : le script est encodé en base64 URL-safe dans `#code=…` (`history.replaceState` à chaque exécution). Un lien ouvert dans un onglet neuf charge et exécute le script ; un changement de hash dans l'onglet courant est aussi pris en compte.
- `localStorage` (`bashtutor.code`) : sauvegarde différée pendant l'édition, restaurée au chargement si aucun `#code=`.

## Diagramme de flux de données complet

```
┌─────────────────────────────────────────────────────────────────────┐
│ 1. PARSER                                                           │
│    normalizeScript(CRLF/BOM) → tree-sitter → findStepNodes           │
│    → steps[] { id, kind, text, startLine, endLine, offsets }         │
│    + firstErrorLine (si syntax error → return tôt)                  │
├─────────────────────────────────────────────────────────────────────┤
│ 2. INSTRUMENT                                                       │
│    collectArrayNames(steps) → noms de tableaux                      │
│    buildPrologue(maxSteps, noms, jeton) → définition des sondes     │
│    instrument(script, steps) → __bt_before/after <id>               │
│    full = prologue + instrumenté + "\n__bt_after END …\n"           │
├─────────────────────────────────────────────────────────────────────┤
│ 3. EXECUTE                                                          │
│    bash.executeSync(full) → { stdout, stderr, exitCode }            │
│    bash.readFile(LOG) → blocs d'état séparés par ___                │
│    bash.readFile(BLLOG) → ordre { seq, id }                          │
├─────────────────────────────────────────────────────────────────────┤
│ 4. RECONSTRUCT                                                      │
│    parseStream(stdout, jeton) → segments { seq, payload }           │
│    parseStream(stderr, jeton) → segments + tail                     │
│    parseBeforeLog(BLLOG) → entries ordonnées                        │
│    parseAfterBlock(bloc) → { seq, id, exit, ctx, vars }             │
├─────────────────────────────────────────────────────────────────────┤
│ 5. PAIR                                                             │
│    for entry of entries:                                            │
│      meta = metaById[entry.id]                                      │
│      block = blockBySeq[entry.seq]                                  │
│      step = {                                                       │
│        text: meta.text, startLine/endLine: meta.*, kind: meta.kind, │
│        vars: block.vars, ctx: block.ctx, exitCode: block.exit,      │
│        stdout: outBySeq[entry.seq], stderr: errBySeq[entry.seq],    │
│        cumulativeStdout: cumul, …                                   │
│      }                                                              │
├─────────────────────────────────────────────────────────────────────┤
│ 6. EXIT HANDLING                                                    │
│    entrée sans bloc LOG → synthèse avec tail + execExit + étape N-1 │
├─────────────────────────────────────────────────────────────────────┤
│ 7. RETURN                                                           │
│    { steps: result, truncated }                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Limites assumées

- **Fonctions atomiques** : un appel `mafonction args` est une étape (le corps n'est pas détaillé). Sinon `r=$(mafonction)` polluerait `r` avec les marqueurs.
- **Subshells non instrumentés** : `$(…)`, `<(…)`, `( … )` ne produisent pas de pas à pas interne.
- **Listes `&&` / `||` atomiques** : `a && b` est une étape (le découpage casserait le court-circuit).
- **Pas de `read` interactif** : bashkit ne gère pas l'entrée interactive.
- **Commandes externes** : limitées aux builtins de bashkit. `cat`, `sort`, `tr`, `grep`, `wc`, `seq`, `mapfile` fonctionnent car implémentés dans bashkit ; d'autres binaires externes peuvent ne pas être disponibles.
