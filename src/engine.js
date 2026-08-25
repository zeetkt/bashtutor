import { initBashkit, Bash } from "@everruns/bashkit-wasm";
import { initParser, findStepNodes, firstErrorLine } from "./parser.js";
import { parseDeclareP, filterUserVars } from "./vars.js";

const MARK = "__BTM_9F3K__";
const LOG = "/tmp/__bt_log_9F3K.log";
const BLLOG = "/tmp/__bt_bl_9F3K.log";
const END = "END";
const TRUNC = "TRUNC";

let ready = null;

export function initEngine({ bashWasm, grammarWasm, parserCoreWasm }) {
  if (!ready) {
    ready = (async () => {
      await initBashkit(bashWasm);
      await initParser(grammarWasm, parserCoreWasm);
    })();
  }
  return ready;
}

function collectArrayNames(steps, script) {
  const names = new Set();
  const patterns = [
    /([A-Za-z_][A-Za-z0-9_]*)\s*(?:\+=|=)\s*\(/g,
    /([A-Za-z_][A-Za-z0-9_]*)\s*\[[^\]]*\]\s*(?:\+=|=)/g,
    /\b(?:mapfile|readarray)\b(?:\s+-[A-Za-z]+)*\s+([A-Za-z_][A-Za-z0-9_]*)/g,
    /\bread\b(?:\s+-[A-Za-z]+)*\s+-a\s+([A-Za-z_][A-Za-z0-9_]*)/g,
  ];
  const reDecl = /\b(?:declare|typeset|local|readonly|export)\s+(-[A-Za-z]+\s+)+([A-Za-z_][A-Za-z0-9_]*)/g;
  for (const s of steps) {
    const text = script.slice(s.startIndex, s.endIndex);
    for (const re of patterns) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) names.add(m[1]);
    }
    reDecl.lastIndex = 0;
    let m;
    while ((m = reDecl.exec(text))) {
      if (/-[aA]\b/.test(m[1])) names.add(m[2]);
    }
  }
  return [...names];
}

function buildPrologue(maxSteps, arrNames) {
  const arrStr = arrNames.join(" ");
  return `__bt_before() {
  __bt_count=$(( __bt_count + 1 ))
  if [ "$__bt_count" -gt '${maxSteps}' ]; then
    printf '${MARK}${TRUNC}\\n'
    printf '${MARK}${TRUNC}\\n' >&2
    printf '${TRUNC}\\n' >> '${BLLOG}'
    exit 0
  fi
  printf '%s\\n' "$1" >> '${BLLOG}'
}
__bt_after() {
  __bt_prev=$?
  printf '${MARK}%s\\n' "$1"
  printf '${MARK}%s\\n' "$1" >&2
  printf 'M|%s|%s|%s|%s|%s|%s\\n' "$1" "$__bt_prev" "$0" "$#" "$*" "$PWD" >> '${LOG}'
  { declare -p; } >> '${LOG}' 2>> '${LOG}'
  for __bt_n in ${arrStr}; do declare -p "$__bt_n" >> '${LOG}' 2>> '${LOG}'; done
  printf '___\\n' >> '${LOG}'
}
__bt_count=0
: > '${LOG}'
: > '${BLLOG}'
`;
}

function instrument(script, steps) {
  let out = script;
  const sorted = [...steps].sort((a, b) => b.startIndex - a.startIndex);
  for (const s of sorted) {
    const line = s.startLine + 1;
    out =
      out.slice(0, s.endIndex) +
      `; __bt_after ${line}` +
      out.slice(s.endIndex);
    out =
      out.slice(0, s.startIndex) +
      `__bt_before ${line}; ` +
      out.slice(s.startIndex);
  }
  return out;
}

function splitByMarkers(stream) {
  if (!stream) return [];
  const lines = stream.split("\n");
  const segs = [];
  let cur = [];
  for (const line of lines) {
    const m = line.match(/^__BTM_9F3K__(.+)$/);
    if (m) {
      segs.push({ marker: m[1], text: cur.join("\n"), count: cur.length });
      cur = [];
    } else {
      cur.push(line);
    }
  }
  return segs;
}

function parseAfterBlock(block) {
  const lines = block.split("\n").filter((l) => l !== "");
  if (!lines.length) return null;
  const head = lines[0].split("|");
  if (head[0] !== "M") return null;
  const declareLines = lines.slice(1).filter((l) => l.startsWith("declare "));
  return {
    line: head[1] === END ? null : Number(head[1]),
    exit: head[2] === "" || head[2] === undefined ? null : Number(head[2]),
    ctx: { argv0: head[3] || "", argc: Number(head[4]) || 0, argv: head[5] || "", cwd: head[6] || "" },
    vars: filterUserVars(parseDeclareP(declareLines.join("\n"))),
  };
}

export function runScript(script, { maxSteps = 200 } = {}) {
  if (!ready) throw new Error("initEngine() doit être appelé avant runScript()");

  const errLine = firstErrorLine(script);
  if (errLine !== null) {
    return { error: { kind: "syntax", line: errLine } };
  }

  const { steps } = findStepNodes(script);
  if (steps.length === 0) {
    return { steps: [], truncated: false };
  }

  const arrayNames = collectArrayNames(steps, script);
  const prologue = buildPrologue(maxSteps, arrayNames);
  const instrumented = instrument(script, steps);
  const full = prologue + instrumented + `\n__bt_after ${END}\n`;

  const bash = new Bash();
  let res;
  try {
    res = bash.executeSync(full);
  } catch (e) {
    return { error: { kind: "runtime", message: e.message } };
  }

  let logContent = "";
  try {
    logContent = bash.readFile(LOG) || "";
  } catch {
    logContent = "";
  }
  let blContent = "";
  try {
    blContent = bash.readFile(BLLOG) || "";
  } catch {
    blContent = "";
  }

  const stdout = res.stdout || "";
  const stderr = res.stderr || "";
  const execExit = res.exitCode ?? 0;

  const outSegs = splitByMarkers(stdout);
  const errSegs = splitByMarkers(stderr);
  const hasEnd = outSegs.some((s) => s.marker === END);
  const hasTrunc = outSegs.some((s) => s.marker === TRUNC);

  const blLines = blContent.split("\n").map((l) => l.trim()).filter(Boolean);
  const afterBlocks = logContent
    .split("___\n")
    .map((b) => b.trim())
    .filter(Boolean)
    .map(parseAfterBlock)
    .filter(Boolean);

  const cmdBlocks = afterBlocks.filter((b) => b.line !== null);
  const sourceLines = script.split("\n");
  const cmdSegs = outSegs.filter((s) => s.marker !== END && s.marker !== TRUNC);
  const cmdErrSegs = errSegs.filter((s) => s.marker !== END && s.marker !== TRUNC);

  const result = [];
  let cumOut = "";
  let cumErr = "";

  for (let k = 0; k < cmdBlocks.length; k++) {
    const b = cmdBlocks[k];
    const seg = cmdSegs[k];
    const eseg = cmdErrSegs[k];
    const out = seg && seg.count > 0 ? seg.text + "\n" : "";
    const err = eseg && eseg.count > 0 ? eseg.text + "\n" : "";
    cumOut += out;
    cumErr += err;
    result.push({
      index: k,
      startLine: b.line - 1,
      endLine: b.line - 1,
      type: "command",
      text: sourceLines[b.line - 1] || "",
      stdout: out,
      stderr: err,
      exitCode: b.exit,
      success: b.exit === 0,
      ended: false,
      vars: b.vars,
      ctx: b.ctx,
      cumulativeStdout: cumOut,
      cumulativeStderr: cumErr,
    });
  }

  if (!hasEnd && !hasTrunc) {
    const exitLineStr = blLines[cmdBlocks.length];
    if (exitLineStr !== undefined && exitLineStr !== TRUNC) {
      const lineNum = Number(exitLineStr);
      if (!Number.isNaN(lineNum)) {
        const lastBlock = cmdBlocks.length ? cmdBlocks[cmdBlocks.length - 1] : null;
        result.push({
          index: cmdBlocks.length,
          startLine: lineNum - 1,
          endLine: lineNum - 1,
          type: "command",
          text: sourceLines[lineNum - 1] || "",
          stdout: "",
          stderr: "",
          exitCode: execExit,
          success: execExit === 0,
          ended: true,
          vars: lastBlock ? lastBlock.vars : {},
          ctx: lastBlock ? lastBlock.ctx : { argv0: "", argc: 0, argv: "", cwd: "" },
          cumulativeStdout: cumOut,
          cumulativeStderr: cumErr,
        });
      }
    }
  }

  return { steps: result, truncated: hasTrunc };
}
