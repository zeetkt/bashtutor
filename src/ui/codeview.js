export function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderCode(container, script, step) {
  const lines = script.split("\n");
  const html = lines
    .map((line, idx) => {
      const n = idx + 1;
      const isCurrent =
        step !== null && step !== undefined && n >= step.startLine + 1 && n <= step.endLine + 1;
      const cls = "line" + (isCurrent ? " current" : "");
      const txt = escapeHtml(line) || "&nbsp;";
      return `<div class="${cls}" data-line="${n}"><span class="ln">${String(n).padStart(2)}</span><span class="code">${txt}</span></div>`;
    })
    .join("");
  container.innerHTML = `<div class="codeblock">${html}</div>`;
  if (step !== null && step !== undefined) {
    const el = container.querySelector(".line.current");
    if (el) {
      container.scrollTop = Math.max(0, el.offsetTop - container.clientHeight / 2);
    }
  }
}

export function renderCurrentStmt(container, step, truncated) {
  if (step === null || step === undefined) {
    container.textContent = "Clique sur « Visualiser l'exécution » pour démarrer.";
    return;
  }
  if (truncated && step.ended) {
    container.textContent = "";
    return;
  }
  container.innerHTML = `<span class="stmt-label">Exécution&nbsp;:</span> <code>${escapeHtml(step.text)}</code>`;
}
