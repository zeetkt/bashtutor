import { initEngine, runScript } from "./engine.js";
import { EXAMPLES } from "./examples.js";
import { createEditor, setEditorDoc } from "./ui/editor.js";
import { renderCode, renderCurrentStmt } from "./ui/codeview.js";
import { renderVariables, renderContext, renderOutput } from "./ui/panels.js";
import { createControls } from "./ui/controls.js";

const MAX_STEPS = 200;

const el = {
  editor: document.getElementById("editor"),
  code: document.getElementById("code"),
  currentStmt: document.getElementById("current-stmt"),
  vars: document.getElementById("vars"),
  context: document.getElementById("context"),
  output: document.getElementById("output"),
  example: document.getElementById("example-select"),
  run: document.getElementById("run-btn"),
  status: document.getElementById("status"),
  errbanner: document.getElementById("errbanner"),
};

const state = {
  steps: [],
  idx: -1,
  truncated: false,
  doc: EXAMPLES[0].code,
  editorView: null,
};

function clamp(i) {
  return Math.max(0, Math.min(state.steps.length - 1, i));
}

function render() {
  const step = state.idx >= 0 ? state.steps[state.idx] : null;
  renderCode(el.code, state.doc, step);
  renderCurrentStmt(el.currentStmt, step, state.truncated);
  const prev = state.idx > 0 ? state.steps[state.idx - 1].vars : {};
  renderVariables(el.vars, step ? step.vars : {}, prev);
  renderContext(el.context, step);
  renderOutput(el.output, state.steps, state.idx);
  controls.setSteps(state.steps.length, state.idx);
}

function goFirst() {
  if (!state.steps.length) return;
  state.idx = 0;
  render();
}
function goBack() {
  if (!state.steps.length) return;
  state.idx = clamp(state.idx - 1);
  render();
}
function goNext() {
  if (state.idx < state.steps.length - 1) {
    state.idx += 1;
    render();
    return true;
  }
  return false;
}
function goLast() {
  if (!state.steps.length) return;
  state.idx = state.steps.length - 1;
  render();
}

const controls = createControls({
  onFirst: goFirst,
  onBack: goBack,
  onNext: goNext,
  onLast: goLast,
  onAutoStep: goNext,
});

function showError(error) {
  const line = error.line ? ` (ligne ${error.line})` : "";
  const msg =
    error.kind === "syntax"
      ? `Erreur de syntaxe${line} : le script ne peut pas être analysé.`
      : `Erreur : ${error.message || "inconnue"}`;
  el.errbanner.textContent = msg;
  el.errbanner.classList.remove("warn");
  el.errbanner.classList.add("show");
}
function showInfo(msg) {
  el.errbanner.textContent = msg;
  el.errbanner.classList.add("show", "warn");
}
function hideBanner() {
  el.errbanner.classList.remove("show", "warn");
}

function run(code) {
  controls.stop();
  hideBanner();
  try {
    const r = runScript(code, { maxSteps: MAX_STEPS });
    if (r.error) {
      state.steps = [];
      state.idx = -1;
      state.truncated = false;
      showError(r.error);
      render();
      return;
    }
    state.steps = r.steps;
    state.truncated = !!r.truncated;
    state.idx = r.steps.length ? 0 : -1;
    if (state.truncated) {
      showInfo(`Script trop long : tronqué à ${MAX_STEPS} étapes.`);
    }
    render();
  } catch (e) {
    state.steps = [];
    state.idx = -1;
    showError({ kind: "runtime", message: e.message });
    render();
  }
}

window.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  if (e.target.closest && e.target.closest(".cm-content")) return;
  if (e.key === "ArrowRight") goNext();
  else goBack();
});

async function main() {
  for (const [i, ex] of EXAMPLES.entries()) {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = ex.name;
    el.example.appendChild(opt);
  }
  el.example.value = "0";

  el.example.addEventListener("change", () => {
    const ex = EXAMPLES[Number(el.example.value)];
    state.doc = ex.code;
    setEditorDoc(el.editorView, ex.code);
    run(state.doc);
  });

  el.run.addEventListener("click", () => {
    state.doc = el.editorView.state.doc.toString();
    run(state.doc);
  });

  document.querySelectorAll(".side-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".side-tab").forEach((t) => t.classList.toggle("active", t === tab));
      document.querySelectorAll(".side-pane").forEach((p) => {
        p.classList.toggle("active", p.id === tab.dataset.tab);
      });
    });
  });

  el.editorView = createEditor(el.editor, state.doc);

  try {
    await initEngine({
      bashWasm: "/bashkit.wasm",
      grammarWasm: "/tree-sitter-bash.wasm",
      parserCoreWasm: "/web-tree-sitter.wasm",
    });
    el.status.textContent = "Moteur prêt ✓";
  } catch (e) {
    el.status.textContent = "Échec du chargement du moteur";
    showError({ kind: "runtime", message: e.message });
    return;
  }
  run(state.doc);
}

main();
