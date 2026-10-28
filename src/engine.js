import { initBashkit, Bash } from "@everruns/bashkit-wasm";
import { initParser, findStepNodes, firstErrorLine } from "./parser.js";
import { parseDeclareP, filterUserVars } from "./vars.js";

const LOG = "/tmp/__bt_log_9F3K.log";
const BLLOG = "/tmp/__bt_bl_9F3K.log";
const SEP = "\x1e";
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

export function normalizeScript(script) {
  return String(script ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n");
}

function makeToken() {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.getRandomValues === "function") {
    const bytes = new Uint8Array(8);
    cryptoApi.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  return Math.random().toString(36).slice(2, 12);
}

function collectArrayNames(steps) {
  const names = new Set();
  const patterns = [
    /([A-Za-z_][A-Za-z0-9_]*)\s*(?:\+=|=)\s*\(/g,
    /([A-Za-z_][A-Za-z0-9_]*)\s*\[[^\]]*\]\s*(?:\+=|=)/g,
    /\b(?:mapfile|readarray)\b(?:\s+-[A-Za-z]+)*\s+([A-Za-z_][A-Za-z0-9_]*)/g,
    /\bread\b(?:\s+-[A-Za-z]+)*\s+-a\s+([A-Za-z_][A-Za-z0-9_]*)/g,
  ];
  const reDecl = /\b(?:declare|typeset|local|readonly|export)\s+(-[A-Za-z]+\s+)+([A-Za-z_][A-Za-z0-9_]*)/g;
  for (const s of steps) {
    const text = s.text;
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

function buildPrologue(maxSteps, arrNames, token) {
  const arrStr = arrNames.join(" ");
  return `__bt_before() {
  __bt_in=$?
  __bt_count=$(( __bt_count + 1 ))
  __bt_seq=$(( __bt_seq + 1 ))
  if [ "$__bt_count" -gt '${maxSteps}' ]; then
    printf '\\036${token}:${TRUNC}:${TRUNC}\\n'
    printf '\\036${token}:${TRUNC}:${TRUNC}\\n' >&2
    printf 'T\\n' >> '${BLLOG}'
    exit 0
  fi
  printf 'B|%s|%s\\n' "$__bt_seq" "$1" >> '${BLLOG}'
  return $__bt_in
}
__bt_after() {
  __bt_prev=$?
  printf '\\036${token}:%s:%s\\n' "$__bt_seq" "$1"
  printf '\\036${token}:%s:%s\\n' "$__bt_seq" "$1" >&2
  printf 'M|%s|%s|%s|%s|%s|%s|%s\\n' "$__bt_seq" "$1" "$__bt_prev" "$2" "$3" "$PWD" "$4" >> '${LOG}'
  { declare -p; } >> '${LOG}' 2>> '${LOG}'
  for __bt_n in ${arrStr}; do declare -p "$__bt_n" >> '${LOG}' 2>> '${LOG}'; done
  printf '___\\n' >> '${LOG}'
  return $__bt_prev
}
__bt_count=0
__bt_seq=0
: > '${LOG}'
: > '${BLLOG}'
`;
}

function instrument(script, steps) {
  let out = script;
  const sorted = [...steps].sort((a, b) => b.startIndex - a.startIndex);
  for (const s of sorted) {
    out = out.slice(0, s.endIndex) + `; __bt_after ${s.id} "$0" "$#" "$*"` + out.slice(s.endIndex);
    out = out.slice(0, s.startIndex) + `__bt_before ${s.id}; ` + out.slice(s.startIndex);
  }
  return out;
}

function parseStream(stream, token) {
  const prefix = SEP + token + ":";
  const segments = [];
  let cursor = 0;
  let pos = 0;
  let truncated = false;
  while (pos < stream.length) {
    const start = stream.indexOf(prefix, pos);
    if (start < 0) break;
    const newline = stream.indexOf("\n", start + prefix.length);
    if (newline < 0) break;
    const head = stream.slice(start + prefix.length, newline);
    const colon = head.indexOf(":");
    const id = colon < 0 ? head : head.slice(colon + 1);
    const payload = stream.slice(cursor, start);
    if (id === TRUNC) truncated = true;
    else if (id !== END) segments.push({ seq: Number(head.slice(0, colon)), payload });
    cursor = newline + 1;
    pos = cursor;
  }
  return { segments, truncated, tail: stream.slice(cursor) };
}

function parseAfterBlock(block) {
  const lines = block.split("\n").filter((l) => l !== "");
  if (!lines.length) return null;
  const head = lines[0].split("|");
  if (head[0] !== "M") return null;
  const declareLines = lines.slice(1).filter((l) => l.startsWith("declare "));
  return {
    seq: Number(head[1]),
    id: head[2],
    exit: head[3] === "" ? null : Number(head[3]),
    ctx: {
      argv0: head[4] || "",
      argc: Number(head[5]) || 0,
      cwd: head[6] || "",
      argv: head.slice(7).join("|"),
    },
    vars: filterUserVars(parseDeclareP(declareLines.join("\n"))),
  };
}

function parseBeforeLog(content) {
  const entries = [];
  let truncated = false;
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line === "T") {
      truncated = true;
      continue;
    }
    if (!line.startsWith("B|")) continue;
    const parts = line.split("|");
    entries.push({ seq: Number(parts[1]), id: parts[2] });
  }
  return { entries, truncated };
}

function readFileSafe(bash, path) {
  try {
    return bash.readFile(path) || "";
  } catch {
    return "";
  }
}

function translateError(message) {
  if (/parse error at line/i.test(message)) {
    return "Le moteur Bash n'a pas pu analyser le script instrumenté.";
  }
  return message;
}

export function runScript(rawScript, { maxSteps = 200 } = {}) {
  if (!ready) throw new Error("initEngine() doit être appelé avant runScript()");

  const script = normalizeScript(rawScript);

  const errLine = firstErrorLine(script);
  if (errLine !== null) {
    return { error: { kind: "syntax", line: errLine } };
  }

  const { steps: nodes } = findStepNodes(script);
  if (!nodes.length) {
    return { steps: [], truncated: false };
  }

  const token = makeToken();
  const arrayNames = collectArrayNames(nodes);
  const prologue = buildPrologue(maxSteps, arrayNames, token);
  const instrumented = instrument(script, nodes);
  const full = prologue + instrumented + `\n__bt_after ${END} "$0" "$#" "$*"\n`;

  const bash = new Bash();
  let res;
  try {
    res = bash.executeSync(full);
  } catch (e) {
    return { error: { kind: "runtime", message: translateError(e.message), detail: e.message } };
  }

  const logContent = readFileSafe(bash, LOG);
  const blContent = readFileSafe(bash, BLLOG);

  const stdout = res.stdout || "";
  const stderr = res.stderr || "";
  const execExit = res.exitCode ?? 0;

  const outParse = parseStream(stdout, token);
  const errParse = parseStream(stderr, token);
  const { entries, truncated: blTruncated } = parseBeforeLog(blContent);

  const blocks = logContent
    .split("___\n")
    .map((b) => b.trim())
    .filter(Boolean)
    .map(parseAfterBlock)
    .filter((b) => b && b.id !== END && b.id !== TRUNC);

  const blockBySeq = new Map(blocks.map((b) => [b.seq, b]));
  const outBySeq = new Map(outParse.segments.map((s) => [s.seq, s.payload]));
  const errBySeq = new Map(errParse.segments.map((s) => [s.seq, s.payload]));
  const metaById = new Map(nodes.map((n) => [String(n.id), n]));

  const result = [];
  let cumOut = "";
  let cumErr = "";
  let prevVars = {};
  let prevCtx = { argv0: "", argc: 0, argv: "", cwd: "" };

  for (const entry of entries) {
    const meta = metaById.get(String(entry.id));
    if (!meta) continue;
    const block = blockBySeq.get(entry.seq);
    const out = outBySeq.get(entry.seq) || "";
    const err = errBySeq.get(entry.seq) || "";

    if (!block) {
      result.push({
        index: result.length,
        startLine: meta.startLine,
        endLine: meta.endLine,
        type: meta.type,
        kind: meta.kind,
        text: meta.text,
        stdout: outParse.tail,
        stderr: errParse.tail,
        exitCode: execExit,
        success: execExit === 0,
        ended: true,
        vars: prevVars,
        ctx: prevCtx,
        cumulativeStdout: cumOut + outParse.tail,
        cumulativeStderr: cumErr + errParse.tail,
      });
      break;
    }

    cumOut += out;
    cumErr += err;
    result.push({
      index: result.length,
      startLine: meta.startLine,
      endLine: meta.endLine,
      type: meta.type,
      kind: meta.kind,
      text: meta.text,
      stdout: out,
      stderr: err,
      exitCode: block.exit ?? 0,
      success: (block.exit ?? 0) === 0,
      ended: false,
      vars: block.vars,
      ctx: block.ctx,
      cumulativeStdout: cumOut,
      cumulativeStderr: cumErr,
    });
    prevVars = block.vars;
    prevCtx = block.ctx;
  }

  return { steps: result, truncated: blTruncated || outParse.truncated };
}
