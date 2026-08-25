import { escapeHtml } from "./codeview.js";
import { computeVarDiff } from "../diff.js";

const KIND_LABEL = {
  string: "chaîne",
  int: "entier",
  array: "tableau",
  assoc: "associatif",
};

function quote(s) {
  return JSON.stringify(s);
}

function formatValue(v) {
  if (v.kind === "array") {
    return "[ " + v.value.map((p) => quote(p[1])).join(", ") + " ]";
  }
  if (v.kind === "assoc") {
    return "{ " + v.value.map((p) => `${quote(p[0])}: ${quote(p[1])}`).join(", ") + " }";
  }
  return quote(v.value);
}

function badges(v) {
  const parts = [KIND_LABEL[v.kind] || v.kind];
  if (v.readonly) parts.push("lecture seule");
  if (v.exported) parts.push("exportée");
  return parts;
}

export function renderVariables(container, vars, prevVars) {
  if (!vars || Object.keys(vars).length === 0) {
    container.innerHTML = '<div class="muted">(aucune variable définie)</div>';
    return;
  }
  const diff = computeVarDiff(prevVars || {}, vars);
  const names = Object.keys(vars).sort((a, b) => a.localeCompare(b));

  const rows = names
    .map((name) => {
      const v = vars[name];
      const stateCls = diff.added.includes(name)
        ? " added"
        : diff.changed.includes(name)
          ? " changed"
          : "";
      return `<div class="var ${stateCls}">
        <span class="vname">${escapeHtml(name)}</span>
        <span class="vbadge">${badges(v).join(" · ")}</span>
        <span class="vval">${escapeHtml(formatValue(v))}</span>
      </div>`;
    })
    .join("");

  const removedRows = diff.removed
    .map((n) => `<div class="var removed"><span class="vname">${escapeHtml(n)}</span><span class="vval">(supprimée)</span></div>`)
    .join("");

  container.innerHTML = rows + removedRows;
}

export function renderContext(container, step) {
  if (!step) {
    container.innerHTML = '<div class="muted">—</div>';
    return;
  }
  const rows = [
    ["Répertoire ($PWD)", step.ctx.cwd],
    ["Script ($0)", step.ctx.argv0],
    ["Arguments ($#)", String(step.ctx.argc)],
    ["Valeur de $@", step.ctx.argv],
    ["Code de sortie ($?)", String(step.exitCode)],
    ["Succès", step.success ? "oui" : "non"],
  ];
  container.innerHTML = rows
    .map(([k, v]) => `<div class="ctx-row"><span class="ctx-k">${k}</span><span class="ctx-v">${escapeHtml(v || "")}</span></div>`)
    .join("");
}

export function renderOutput(container, steps, idx) {
  if (!steps || idx < 0) {
    container.innerHTML = '<div class="muted">(aucune sortie)</div>';
    return;
  }
  const chunks = [];
  for (let i = 0; i <= idx; i++) {
    const s = steps[i];
    const out = escapeHtml(s.stdout);
    const err = escapeHtml(s.stderr);
    if (!out && !err) continue;
    const cls = "chunk" + (i === idx ? " current" : "");
    chunks.push(
      `<div class="${cls}"><span class="stepno">#${i + 1}</span>` +
        (out ? `<span class="out">${out}</span>` : "") +
        (err ? `<span class="err">${err}</span>` : "") +
        `</div>`,
    );
  }
  container.innerHTML = chunks.length ? chunks.join("") : '<div class="muted">(aucune sortie)</div>';
  const cur = container.querySelector(".chunk.current");
  if (cur) {
    const top = cur.offsetTop - container.clientHeight / 2 + cur.clientHeight / 2;
    container.scrollTop = Math.max(0, top);
  }
}
