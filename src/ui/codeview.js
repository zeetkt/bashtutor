export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildCode(container, script) {
  const lines = script.split("\n");
  const width = String(lines.length).length;
  const html = lines
    .map((line, idx) => {
      const n = idx + 1;
      const txt = escapeHtml(line) || "&nbsp;";
      return `<div class="line" data-line="${n}"><button class="ln" type="button" tabindex="-1" data-line="${n}" title="Aller à l'étape de la ligne ${n}" disabled>${String(n).padStart(width)}</button><span class="code">${txt}</span></div>`;
    })
    .join("");
  container.innerHTML = `<div class="codeblock">${html}</div>`;
  container.dataset.script = script;
}

function markClickable(container, steps) {
  const lines = new Set();
  for (const step of steps) {
    for (let n = step.startLine + 1; n <= step.endLine + 1; n++) lines.add(n);
  }
  for (const button of container.querySelectorAll(".ln")) {
    button.disabled = !lines.has(Number(button.dataset.line));
  }
}

export function renderCode(container, script, step, errorLine, steps = []) {
  if (container.dataset.script !== script) buildCode(container, script);
  markClickable(container, steps);

  for (const el of container.querySelectorAll(".line.current")) el.classList.remove("current");
  for (const el of container.querySelectorAll(".line.error")) el.classList.remove("error");

  if (step) {
    for (let n = step.startLine + 1; n <= step.endLine + 1; n++) {
      const el = container.querySelector(`.line[data-line="${n}"]`);
      if (el) el.classList.add("current");
    }
    const current = container.querySelector(".line.current");
    if (current) {
      const top = current.offsetTop - container.clientHeight / 2 + current.clientHeight / 2;
      container.scrollTop = Math.max(0, top);
    }
  }

  if (errorLine) {
    const el = container.querySelector(`.line[data-line="${errorLine}"]`);
    if (el) el.classList.add("error");
  }
}

export function renderCurrentStmt(container, step) {
  if (!step) {
    container.innerHTML = '<span class="muted">Clique sur « Visualiser l\u2019exécution » pour démarrer.</span>';
    return;
  }
  const label = step.kind === "condition" ? "Condition" : "Exécution";
  const ended = step.ended ? ` <span class="stmt-flag">fin du script (code ${step.exitCode})</span>` : "";
  container.innerHTML = `<span class="stmt-label">${label}&nbsp;:</span> <code>${escapeHtml(step.text)}</code>${ended}`;
}
