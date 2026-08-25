import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { initEngine, runScript } from "../src/engine.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const bashWasm = readFileSync(
  join(__dirname, "..", "node_modules", "@everruns", "bashkit-wasm", "bashkit_wasm_bg.wasm"),
);
const grammarWasm = join(
  __dirname, "..", "node_modules", "tree-sitter-bash", "tree-sitter-bash.wasm",
);

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
  // somme=0, 3×(somme=…), echo => 5 étapes
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

test("if : seule la branche exécutée devient une étape", () => {
  const script = `x=5
if [ $x -gt 3 ]; then echo grand; else echo petit; fi`;
  const { steps } = runScript(script);
  // x=5 + echo grand (la branche else n'est pas exécutée)
  assert.equal(steps.length, 2);
  assert.equal(steps[1].stdout.trim(), "grand");
});

test("while : itérations pas à pas", () => {
  const script = `n=0
while [ $n -lt 2 ]; do echo "n=$n"; n=$((n+1)); done`;
  const { steps } = runScript(script);
  const echos = steps.filter((s) => s.stdout.includes("n="));
  assert.equal(echos.length, 2);
  assert.equal(echos[0].stdout.trim(), "n=0");
  assert.equal(echos[1].stdout.trim(), "n=1");
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
