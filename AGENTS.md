# AGENTS.md

Guide pour les assistants IA (et tout contributeur) travaillant sur Bash Tutor. **À lire avant de toucher au code.**

## Commandes essentielles

```powershell
npm install            # installer les dépendances
npm run dev            # serveur de dev Vite → http://localhost:5173
npm run build          # build de production → dist/ (vérifier qu'il passe)
npm test               # tests du moteur : node --test tests/engine.test.mjs
```

**Toujours** lancer `npm test` et `npm run build` après toute modification du moteur ou du parser. Les tests doivent rester verts. Si tu ajoutes un comportement, ajoute un test.

## Convention de code

- **ES modules** (`"type": "module"` dans package.json). Pas de `require`, pas de CommonJS.
- **Pas de commentaires** dans le code sauf demande explicite. Le code se commente lui-même.
- **Pas d'emoji** dans le code. (Le README/UI peut en contenir — c'est déjà le cas, respecter l'existant.)
- UI et messages en **français** (les libellés, bannières, états). Noms de variables/fonctions en anglais.
- Indentation : 2 espaces. Pas de tabulations.
- Pas de build step intermédiaire : Vite sert le source directement, le navigateur exécute l'ESM.

## Vérifier dans un vrai navigateur

Les tests Node valident le moteur, mais l'UI doit être vérifiée dans un navigateur. Pour un smoke test headless avec Chrome :

```powershell
# 1. lancer le dev server (détaché, sinon il meurt avec la commande)
$proc = Start-Process -FilePath "npm.cmd" -ArgumentList "run","dev","--","--port","5173","--strictPort" -WindowStyle Hidden -PassThru -RedirectStandardOutput "$env:TEMP\dev.log"
Start-Sleep -Seconds 6
# 2. dump le DOM rendu
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --headless=new --disable-gpu --no-sandbox --virtual-time-budget=15000 --dump-dom "http://localhost:5173/" 2>$null | Out-File -Encoding utf8 "$env:TEMP\dom.html"
# 3. inspecter : #status, #counter, .var, #current-stmt
# 4. tuer le dev server
Stop-Process -Id $proc.Id -Force
```

Vérifier que `#status` contient « Moteur prêt ✓ », que `#counter` affiche `1 / N` (N = nombre d'étapes de l'exemple 01 = 13), et que `#current-stmt` affiche la première commande.

## Architecture : ce qu'il faut savoir

Le détail complet est dans [ARCHITECTURE.md](./ARCHITECTURE.md). Résumé des contraintes incontournables :

### Le moteur n'a **pas** de per-command stepping natif

bashkit-wasm expose `executeSync(script)` qui exécute **tout** le script d'un coup et renvoie `{ stdout, stderr, exitCode }`. Il n'y a pas de point d'arrêt, pas d'API « exécute une commande ». On contourne en **instrumentant le script** : on injecte des sondes autour de chaque commande (repérée via l'AST tree-sitter), on exécute le tout en un appel, puis on découpe les sorties.

### Quirks de bashkit-wasm à respecter (testés, ce sont des faits)

| Tentative | Résultat dans bashkit |
|---|---|
| `trap '…' DEBUG` | se déclenche, mais `LINENO`=1, `BASH_COMMAND` vide, et **stdout du trap est avalé** (non capturé par executeSync). |
| `set -x` + `PS4='${LINENO}'` | trace les commandes mais **PS4 n'est PAS développé** (sortie littérale `${LINENO}`). |
| `BASH_XTRACEFD=3` / `exec 3>f` | **IGNORE** — la redirection de FD ne fonctionne pas. |
| `exec >f` (stdout global vers fichier) | **IGNORE**. |
| `BASH_SUBSHELL`, `BASHPID` | **vides** (impossible de détecter un subshell). |
| `declare -p` (bare) | liste les scalaires seulement. Les tableaux/associatifs nécessitent `declare -p <nom>`. |
| `printf '…' >> fichier` (par commande) | **FONCTIONNE** ✓ |
| `{ declare -p; } >> fichier` (groupe une-ligne) | **FONCTIONNE** ✓ (mais le groupe multi-ligne échoue : "parser fuel exhausted"). |

→ Ne perds pas de temps à réessayer `trap DEBUG`, `set -x` ou les redirections de FD. La solution actuelle (instrumentation + fichiers journaux) est la bonne.

### Types de nœuds (parser.js)

- **STEP_TYPES** (atomiques, on marque et on ne descend pas) : `command`, `variable_assignment`, `declaration_command`, `pipeline`, `list`.
- **SKIP_TYPES** (ne jamais instrumenter à l'intérieur) : `function_definition`, `command_substitution`, `process_substitution`, `subshell`.

`declaration_command` est un STEP_TYPE **crucial** : si on marquait seulement le `variable_assignment` enfant d'un `declare -A m=(…)`, la sonde s'insérerait entre `declare -A` et le nom → le tableau deviendrait indexé au lieu d'associatif. Ne pas le retirer de STEP_TYPES.

Ne pas régresser le bug de pollution : si tu retires `command_substitution`/`function_definition` de SKIP_TYPES, `r=$(add 3 4)` capturera les marqueurs internes et `r` vaudra `__BTM_…`. Garde-les.

### Le contrat de `runScript`

```js
runScript(script, { maxSteps = 200 }) →
  { steps: Step[], truncated: boolean }
  | { error: { kind: "syntax"|"runtime", line?, message? } }
```

Chaque `Step` contient : `index`, `startLine`, `endLine`, `type`, `text`, `stdout`, `stderr`, `exitCode`, `success`, `ended`, `vars`, `ctx`, `cumulativeStdout`, `cumulativeStderr`. Le type `vars` est un objet `{ nom: { name, kind, value, readonly, exported } }` où `kind` ∈ `string|int|array|assoc`.

Les variables système (liste dans `vars.js` SYSTEM_VARS, plus tout préfixe `BASH`, `COMP_`, `__bt`) sont filtrées. **Si tu ajoutes un préfixe de sonde, ajoute-le à `isSystemVar`** pour éviter qu'il apparaisse dans le panneau Variables.

## Pièges courants

- **`maxSteps`** : la limite s'applique au nombre de *commandes exécutées*, pas au nombre de lignes. Une boucle `for i in 1..200` atteint la limite. L'UI signale le tronquage (bannière `warn`).
- **Exit** : `__bt_after END` est un marqueur trailing. Si le script appelle `exit`, ce marqueur n'est pas émis → on synthétise une étape finale depuis le fichier BL (ligne de l'exit) + `execExit`. Ne pas casser cette logique.
- **`$(...)` pollution** : tout `$(...)` exécuté à l'intérieur d'une commande capturée verra les marqueurs si on instrumente à l'intérieur. C'est pourquoi `command_substitution` est SKIP. Même chose pour les corps de fonctions (`function_definition`) car `r=$(mafonction)` capturerait les marqueurs du corps.
- **CRLF** : le projet est sur Windows. Git affiche des warnings LF→CRLF, c'est normal (`.gitattributes` non requis). Les fichiers `.sh` gardent des LF.
- **wasm en Node vs navigateur** : `initParser(grammarPathOrUrl, coreWasmUrl)` — en navigateur, on passe des URLs (`/web-tree-sitter.wasm`) pour `Parser.init({locateFile})` ; en Node (tests), `coreWasmUrl` est omis → `Parser.init()` auto-résout. Les tests passent `bashWasm` en `Buffer` et `grammarWasm` en chemin disque.

## Fichiers à ne pas committer

- `node_modules/`, `dist/` (dans `.gitignore`).
- `probe_*.mjs`, `probe_*.sh` (fichiers de test ponctuels, ignorés par `.gitignore`).
- `tests/debug*.mjs`, `tests/spike*.mjs` — brouillons, ne pas recréer. Garder uniquement `tests/engine.test.mjs`.

## Quand tu ajoutes un exemple

1. Créer `examples/NN-nom.sh`.
2. L'importer dans `src/examples.js` (`import exNN from "../examples/NN-nom.sh?raw"`).
3. L'ajouter au tableau `EXAMPLES`.
4. Vérifier qu'il s'exécute sans erreur et produit des étapes cohérentes (tester via `npm run dev` + navigation).
