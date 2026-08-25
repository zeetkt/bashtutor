function signature(v) {
  return JSON.stringify([v.kind, v.value]);
}

export function computeVarDiff(prevVars, nextVars) {
  const added = [];
  const changed = [];
  const removed = [];
  const names = new Set([...Object.keys(prevVars), ...Object.keys(nextVars)]);
  for (const name of names) {
    const p = prevVars[name];
    const n = nextVars[name];
    if (n && !p) added.push(name);
    else if (p && !n) removed.push(name);
    else if (p && n && signature(p) !== signature(n)) changed.push(name);
  }
  return { added, changed, removed };
}
