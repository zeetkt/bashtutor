import { initEngine, runScript } from "./engine.js";
import { EXAMPLES } from "./examples.js";
import {
  createEditor,
  setEditorDoc,
  highlightLines,
  clearHighlights,
  setEditorTheme,
} from "./ui/editor.js";
import { renderCode, renderCurrentStmt } from "./ui/codeview.js";
import { renderVariables, renderContext, renderOutput, renderExplanation } from "./ui/panels.js";
import { createControls } from "./ui/controls.js";

const MAX_STEPS = 200;
const CODE_KEY = "bashtutor.code";
const THEME_KEY = "bashtutor.theme";
const CUSTOM_EXAMPLE = "-1";
const READY_LABEL = "Moteur prêt ✓";

const el = {
  editor: document.getElementById("editor"),
  code: document.getElementById("code"),
  currentStmt: document.getElementById("current-stmt"),
  explain: document.getElementById("explain"),
  vars: document.getElementById("vars"),
  context: document.getElementById("context"),
  output: document.getElementById("output"),
  example: document.getElementById("example-select"),
  run: document.getElementById("run-btn"),
  share: document.getElementById("share-btn"),
  theme: document.getElementById("theme-btn"),
  status: document.getElementById("status"),
  errbanner: document.getElementById("errbanner"),
};

const state = {
  steps: [],
  idx: -1,
  truncated: false,
  doc: "",
  dirty: false,
  errorLine: null,
  editorView: null,
};

let engineReady = false;
let statusTimer = null;
let saveTimer = null;

function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    return;
  }
}

function encodeCode(code) {
  const bytes = new TextEncoder().encode(code);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeCode(value) {
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

function initialCode() {
  const hash = location.hash;
  if (hash.startsWith("#code=")) {
    const decoded = decodeCode(hash.slice(6));
    if (decoded !== null) return decoded;
  }
  return storageGet(CODE_KEY) || EXAMPLES[0].code;
}

function setStatus(message, temporary = false) {
  el.status.textContent = message;
  if (statusTimer) clearTimeout(statusTimer);
  if (temporary) {
    statusTimer = setTimeout(() => {
      el.status.textContent = engineReady ? READY_LABEL : "";
    }, 2800);
  }
}

function showError(error) {
  const line = error.line ? ` (ligne ${error.line})` : "";
  const message =
    error.kind === "syntax"
      ? `Erreur de syntaxe${line} : le script ne peut pas être analysé.`
      : `Erreur : ${error.message || "inconnue"}`;
  el.errbanner.textContent = message;
  el.errbanner.title = error.detail || "";
  el.errbanner.classList.remove("warn");
  el.errbanner.classList.add("show");
}

function showWarn(message) {
  el.errbanner.textContent = message;
  el.errbanner.title = "";
  el.errbanner.classList.add("show", "warn");
}

function hideBanner() {
  el.errbanner.classList.remove("show", "warn");
  el.errbanner.title = "";
}

function clamp(i) {
  return Math.max(0, Math.min(state.steps.length - 1, i));
}

function render({ reveal = false } = {}) {
  const step = state.idx >= 0 ? state.steps[state.idx] : null;
  const previous = state.idx > 0 ? state.steps[state.idx - 1] : null;
  renderCode(el.code, state.doc, step, state.errorLine, state.steps);
  renderCurrentStmt(el.currentStmt, step);
  renderExplanation(el.explain, previous ? previous.vars : {}, step);
  renderVariables(el.vars, step ? step.vars : {}, previous ? previous.vars : {});
  renderContext(el.context, step);
  renderOutput(el.output, state.steps, state.idx);
  controls.setSteps(state.steps.length, state.idx);
  if (!state.editorView) return;
  if (state.dirty) {
    clearHighlights(state.editorView);
    return;
  }
  highlightLines(
    state.editorView,
    step ? step.startLine + 1 : 0,
    state.errorLine,
    reveal,
  );
}

function goFirst() {
  if (!state.steps.length) return;
  state.idx = 0;
  render({ reveal: true });
}

function goBack() {
  if (!state.steps.length) return;
  state.idx = clamp(state.idx - 1);
  render({ reveal: true });
}

function goNext() {
  if (state.idx < state.steps.length - 1) {
    state.idx += 1;
    render({ reveal: true });
    return true;
  }
  return false;
}

function goLast() {
  if (!state.steps.length) return;
  state.idx = state.steps.length - 1;
  render({ reveal: true });
}

function seek(position) {
  state.idx = clamp(position);
  render({ reveal: true });
}

const controls = createControls({
  onFirst: goFirst,
  onBack: goBack,
  onNext: goNext,
  onLast: goLast,
  onAutoStep: goNext,
  onSeek: seek,
});

function syncUrl(code) {
  try {
    history.replaceState(null, "", `#code=${encodeCode(code)}`);
  } catch {
    return;
  }
}

function run(code) {
  controls.stop();
  hideBanner();
  state.doc = code;
  state.dirty = false;
  state.errorLine = null;
  state.truncated = false;
  try {
    const result = runScript(code, { maxSteps: MAX_STEPS });
    if (result.error) {
      state.steps = [];
      state.idx = -1;
      state.errorLine = result.error.line || null;
      showError(result.error);
      render({ reveal: true });
      syncUrl(code);
      return;
    }
    state.steps = result.steps;
    state.truncated = !!result.truncated;
    state.idx = result.steps.length ? 0 : -1;
    if (state.truncated) {
      showWarn(`Script trop long : tronqué à ${MAX_STEPS} étapes.`);
    }
    render({ reveal: true });
    syncUrl(code);
  } catch (e) {
    state.steps = [];
    state.idx = -1;
    showError({ kind: "runtime", message: e.message });
    render({ reveal: true });
  }
}

function runEditor() {
  run(state.editorView.state.doc.toString());
}

function saveCodeSoon(code) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => storageSet(CODE_KEY, code), 400);
}

function onEditorChange(code) {
  saveCodeSoon(code);
  const dirty = code !== state.doc;
  if (dirty === state.dirty) return;
  state.dirty = dirty;
  if (dirty) {
    clearHighlights(state.editorView);
    el.example.value = CUSTOM_EXAMPLE;
    showWarn("Script modifié : relance l’exécution pour actualiser la trace.");
    return;
  }
  hideBanner();
  render();
}

function onCodeClick(event) {
  const button = event.target.closest ? event.target.closest(".ln") : null;
  if (!button) return;
  const line = Number(button.dataset.line) - 1;
  const index = state.steps.findIndex((step) => line >= step.startLine && line <= step.endLine);
  if (index < 0) return;
  controls.stop();
  state.idx = index;
  render({ reveal: true });
}

function preferredTheme() {
  const saved = storageGet(THEME_KEY);
  if (saved === "dark" || saved === "light") return saved;
  const media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  return media && media.matches ? "dark" : "light";
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  storageSet(THEME_KEY, theme);
  if (state.editorView) setEditorTheme(state.editorView, theme === "dark");
  const next = theme === "dark" ? "clair" : "sombre";
  el.theme.textContent = theme === "dark" ? "☀" : "◐";
  el.theme.setAttribute("aria-label", `Activer le thème ${next}`);
  el.theme.title = `Passer au thème ${next}`;
}

async function share() {
  const code = state.editorView.state.doc.toString();
  syncUrl(code);
  try {
    await navigator.clipboard.writeText(location.href);
    setStatus("Lien copié dans le presse-papiers", true);
  } catch {
    setStatus("Lien présent dans la barre d’adresse", true);
  }
}

function setupExamples() {
  const custom = document.createElement("option");
  custom.value = CUSTOM_EXAMPLE;
  custom.textContent = "— script personnalisé —";
  custom.disabled = true;
  el.example.appendChild(custom);

  for (const [i, example] of EXAMPLES.entries()) {
    const option = document.createElement("option");
    option.value = String(i);
    option.textContent = example.name;
    el.example.appendChild(option);
  }

  el.example.addEventListener("change", () => {
    if (el.example.value === CUSTOM_EXAMPLE) return;
    const example = EXAMPLES[Number(el.example.value)];
    state.doc = example.code;
    state.dirty = false;
    setEditorDoc(state.editorView, example.code);
    run(example.code);
  });
}

function setupTabs() {
  const tabs = [...document.querySelectorAll(".side-tab")];
  const panes = tabs.map((tab) => document.getElementById(tab.dataset.tab));

  function select(tab) {
    for (const candidate of tabs) {
      const active = candidate === tab;
      candidate.classList.toggle("active", active);
      candidate.setAttribute("aria-selected", String(active));
      candidate.tabIndex = active ? 0 : -1;
    }
    for (const pane of panes) {
      const active = pane.id === tab.dataset.tab;
      pane.classList.toggle("active", active);
      pane.hidden = !active;
    }
  }

  for (const tab of tabs) {
    tab.addEventListener("click", () => select(tab));
    tab.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      event.stopPropagation();
      const i = tabs.indexOf(tab);
      const target = tabs[(i + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
      select(target);
      target.focus();
    });
  }
}

function setupKeyboard() {
  window.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      runEditor();
      return;
    }
    if (event.key === "Escape") {
      controls.stop();
      return;
    }
    const target = event.target;
    const inField =
      target && target.closest
        ? target.closest("input, select, textarea, .cm-content, [contenteditable='true']")
        : null;
    if (inField) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      goBack();
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      goNext();
    } else if (event.key === "Home") {
      event.preventDefault();
      goFirst();
    } else if (event.key === "End") {
      event.preventDefault();
      goLast();
    }
  });
}

function assetUrl(name) {
  return `${import.meta.env.BASE_URL}${name}`;
}

async function main() {
  state.doc = initialCode();
  const exampleIndex = EXAMPLES.findIndex((example) => example.code === state.doc);

  setupExamples();
  el.example.value = exampleIndex >= 0 ? String(exampleIndex) : CUSTOM_EXAMPLE;

  state.editorView = createEditor(el.editor, state.doc, { onChange: onEditorChange });
  applyTheme(preferredTheme());

  el.run.addEventListener("click", runEditor);
  el.share.addEventListener("click", share);
  el.theme.addEventListener("click", () => {
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  });
  el.code.addEventListener("click", onCodeClick);
  setupTabs();
  setupKeyboard();

  window.addEventListener("hashchange", () => {
    if (!location.hash.startsWith("#code=")) return;
    const decoded = decodeCode(location.hash.slice(6));
    if (decoded === null || decoded === state.doc) return;
    state.doc = decoded;
    state.dirty = false;
    setEditorDoc(state.editorView, decoded);
    run(decoded);
  });

  try {
    await initEngine({
      bashWasm: assetUrl("bashkit.wasm"),
      grammarWasm: assetUrl("tree-sitter-bash.wasm"),
      parserCoreWasm: assetUrl("web-tree-sitter.wasm"),
    });
    engineReady = true;
    setStatus(READY_LABEL);
  } catch (e) {
    setStatus("Échec du chargement du moteur");
    showError({ kind: "runtime", message: e.message });
    return;
  }

  run(state.doc);
}

main();
