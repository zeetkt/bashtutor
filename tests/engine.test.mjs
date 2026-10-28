import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { initEngine, runScript, normalizeScript } from "../src/engine.js";
import { parseDeclareP } from "../src/vars.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const bashWasm = readFileSync(
  join(__dirname, "..", "node_modules", "@everruns", "bashkit-wasm", "bashkit_wasm_bg.wasm"),
);
const grammarWasm = join(
  __dirname, "..", "node_modules", "tree-sitter-bash", "tree-sitter-bash.wasm",
);
const examplesDir = join(__dirname, "..", "examples");

before(async () => {
  await initEngine({ bashWasm, grammarWasm });
});

test("boucle for : une étape par itération", () => {
  const script = `somme=0
for i in 1 2 3; do
  somme=$((somme + i))
done
echo "total=$somme"`;
  const { steps, truncated } = runScript(script);
  assert.equal(truncated, false);
  assert.equal(steps.length, 5);

  const iters = steps.filter((s) => s.text.includes("somme=$((somme"));
  assert.equal(iters.length, 3);
  assert.equal(iters[0].vars.somme.value, "1");
  assert.equal(iters[1].vars.somme.value, "3");
  assert.equal(iters[2].vars.somme.value, "6");

  const last = steps[steps.length - 1];
  assert.equal(last.vars.somme.value, "6");
  assert.match(last.stdout, /total=6/);
});

test("if : condition + branche exécutée", () => {
  const script = `x=5
if [ $x -gt 3 ]; then echo grand; else echo petit; fi`;
  const { steps } = runScript(script);
  assert.equal(steps.length, 3);
  assert.equal(steps[1].kind, "condition");
  assert.equal(steps[1].text, "[ $x -gt 3 ]");
  assert.equal(steps[1].exitCode, 0);
  assert.equal(steps[2].stdout.trim(), "grand");
});

test("if : le statut de la condition est préservé", () => {
  const { steps } = runScript(`if grep -q x /nope; then echo yes; else echo no; fi`);
  const echo = steps.find((s) => s.stdout.includes("no"));
  assert.ok(echo, "la branche else doit être exécutée");
  assert.equal(steps[0].kind, "condition");
  assert.equal(steps[0].exitCode, 1);
});

test("$? est préservé après une commande en échec", () => {
  const { steps } = runScript(`false\necho "code=$?"`);
  assert.equal(steps[1].stdout, "code=1\n");
});

test("while : conditions et itérations pas à pas", () => {
  const script = `n=0
while [ $n -lt 2 ]; do echo "n=$n"; n=$((n+1)); done`;
  const { steps } = runScript(script);
  const echos = steps.filter((s) => s.stdout.includes("n="));
  assert.equal(echos.length, 2);
  assert.equal(echos[0].stdout.trim(), "n=0");
  assert.equal(echos[1].stdout.trim(), "n=1");
  const conditions = steps.filter((s) => s.kind === "condition");
  assert.equal(conditions.length, 3);
  assert.equal(conditions[0].exitCode, 0);
  assert.equal(conditions[2].exitCode, 1);
});

test("tableaux et tableaux associatifs", () => {
  const script = `arr=(un deux trois)
declare -A m=([k]=v [w]=z)
echo "\${arr[1]} \${m[k]}"`;
  const { steps } = runScript(script);
  const echo = steps.find((s) => s.stdout.includes("deux"));
  assert.ok(echo, "echo exécuté");
  assert.equal(echo.vars.arr.kind, "array");
  assert.deepEqual(echo.vars.arr.value.map((p) => p[1]), ["un", "deux", "trois"]);
  assert.equal(echo.vars.m.kind, "assoc");
  assert.deepEqual(
    echo.vars.m.value.map((p) => p.join("=")).sort(),
    ["k=v", "w=z"],
  );
});

test("exit : arrêt avec le bon code", () => {
  const script = `echo un
echo deux
exit 7
echo jamais`;
  const { steps } = runScript(script);
  assert.equal(steps.length, 3);
  const last = steps[steps.length - 1];
  assert.equal(last.ended, true);
  assert.equal(last.exitCode, 7);
  assert.match(last.text, /exit 7/);
});

test("commande false : code de sortie 1 sans arrêt", () => {
  const { steps } = runScript("false\necho ok");
  const falseStep = steps[0];
  assert.equal(falseStep.text.trim(), "false");
  assert.equal(falseStep.exitCode, 1);
  assert.equal(steps[1].stdout.trim(), "ok");
});

test("substitution de commande sans pollution de marqueurs", () => {
  const script = `add() { echo $((1 + 2)); }
r=$(add)
echo "r=$r"`;
  const { steps } = runScript(script);
  const rStep = steps.find((s) => s.text.startsWith("r="));
  assert.equal(rStep.vars.r.value, "3");
  const echo = steps.find((s) => s.stdout.includes("r="));
  assert.equal(echo.stdout.trim(), "r=3");
});

test("pipeline en une seule étape", () => {
  const { steps } = runScript("echo a b c | tr ' ' '\\n' | sort");
  assert.equal(steps.length, 1);
  assert.match(steps[0].stdout, /a\nb\nc/);
});

test("erreur de syntaxe -> kind syntax + ligne", () => {
  const r = runScript("echo ok\nif then\n");
  assert.equal(r.error.kind, "syntax");
  assert.equal(r.error.line, 2);
});

test("script vide (commentaires seulement)", () => {
  const r = runScript("# juste un commentaire\n\n");
  assert.equal(r.steps.length, 0);
  assert.equal(r.truncated, false);
});

test("limite maxSteps -> truncated", () => {
  const r = runScript("a=1\nb=2\nc=3\nd=4\ne=5\n", { maxSteps: 2 });
  assert.equal(r.truncated, true);
  assert.equal(r.steps.length, 2);
});

test("contexte (cwd)", () => {
  const r = runScript("cd /tmp\npwd");
  assert.equal(r.steps[0].ctx.cwd, "/tmp");
  assert.ok(r.steps.length >= 2);
});

test("contexte : $0, $# et $@ reflètent le script, pas la sonde", () => {
  const { steps } = runScript('set -- a b\ncd /tmp\necho "$#:$*"');
  const last = steps[steps.length - 1];
  assert.equal(last.ctx.argc, 2);
  assert.equal(last.ctx.argv, "a b");
  assert.equal(last.ctx.cwd, "/tmp");
  assert.ok(last.ctx.argv0);
  assert.notEqual(last.ctx.argv0, "__bt_after");
  assert.equal(last.stdout, "2:a b\n");
});

test("elif : la condition évaluée devient une étape", () => {
  const script = `score=75
if [ "$score" -ge 90 ]; then mention=Excellent
elif [ "$score" -ge 70 ]; then mention=Bien
else mention=Revoir
fi`;
  const { steps } = runScript(script);
  const conditions = steps.filter((s) => s.kind === "condition");
  assert.equal(conditions.length, 2);
  assert.equal(conditions[0].exitCode, 1);
  assert.equal(conditions[1].text, '[ "$score" -ge 70 ]');
  assert.equal(conditions[1].success, true);
  assert.ok(steps.some((s) => s.vars.mention && s.vars.mention.value === "Bien"));
});

test("printf sans retour à la ligne : sortie exacte", () => {
  const { steps } = runScript('printf "abc"\necho "|"');
  assert.equal(steps[0].stdout, "abc");
  assert.equal(steps[1].stdout, "|\n");
  assert.equal(steps[1].cumulativeStdout, "abc|\n");
});

test("un marqueur dans la sortie utilisateur ne crée pas d'étape fantôme", () => {
  const { steps } = runScript('echo "__BTM_9F3K__X"\nprintf "\\036Y\\n"');
  assert.equal(steps.length, 2);
  assert.equal(steps[0].stdout, "__BTM_9F3K__X\n");
  assert.equal(steps[1].stdout, "\x1eY\n");
});

test("CRLF et BOM sont normalisés", () => {
  const { steps, error } = runScript("\uFEFFa=1\r\necho $a\r\n");
  assert.equal(error, undefined);
  assert.equal(steps.length, 2);
  assert.equal(steps[1].stdout, "1\n");
});

test("normalizeScript", () => {
  assert.equal(normalizeScript("\uFEFFa\r\nb\rc"), "a\nb\nc");
});

test("deux commandes sur une ligne : texte exact de chaque étape", () => {
  const { steps } = runScript("a=1; b=2");
  assert.equal(steps.length, 2);
  assert.equal(steps[0].text, "a=1");
  assert.equal(steps[1].text, "b=2");
});

test("commande multi-ligne : texte complet et plage de lignes", () => {
  const { steps } = runScript('echo "un" \\\n  "deux"\necho fin');
  assert.equal(steps[0].text, 'echo "un" \\\n  "deux"');
  assert.equal(steps[0].startLine, 0);
  assert.equal(steps[0].endLine, 1);
  assert.equal(steps[0].stdout, "un deux\n");
});

test("case : le texte de l'étape est la commande, pas la ligne entière", () => {
  const { steps } = runScript(`x=b
case $x in
  a) echo A ;;
  b) echo B ;;
esac`);
  const echoB = steps.find((s) => s.stdout.includes("B"));
  assert.equal(echoB.text, "echo B");
  assert.equal(echoB.startLine, 3);
});

test("les 6 exemples s'exécutent sans erreur", () => {
  const files = readdirSync(examplesDir).filter((f) => f.endsWith(".sh")).sort();
  assert.equal(files.length, 6);
  for (const file of files) {
    const script = readFileSync(join(examplesDir, file), "utf8");
    const r = runScript(script, { maxSteps: 400 });
    assert.equal(r.error, undefined, `${file} ne doit pas échouer`);
    assert.ok(r.steps.length > 0, `${file} doit produire des étapes`);
    assert.ok(r.steps.every((s) => s.text && s.text.trim().length > 0), `${file} : texte d'étape vide`);
  }
});

test("tableaux vides et valeurs ANSI-C", () => {
  const vars = parseDeclareP([
    "declare -a vide=()",
    "declare -A m",
    "declare -- t=$'a\\tb'",
    "declare -i n=\"3\"",
  ].join("\n"));
  assert.equal(vars.vide.kind, "array");
  assert.deepEqual(vars.vide.value, []);
  assert.equal(vars.m.kind, "assoc");
  assert.deepEqual(vars.m.value, []);
  assert.equal(vars.t.value, "a\tb");
  assert.equal(vars.n.kind, "int");
});
