const SYSTEM_VARS = new Set([
  "EUID", "UID", "PPID", "HOME", "HOSTNAME", "USER", "PWD", "OLDPWD",
  "PATH", "SHELL", "SHLVL", "IFS", "PS1", "PS2", "PS3", "PS4",
  "RANDOM", "SECONDS", "LINENO", "FUNCNAME", "_", "GROUPS", "DIRSTACK",
  "PIPESTATUS", "SRANDOM", "MACHTYPE", "HOSTTYPE", "OSTYPE",
  "BASH_REMATCH", "BASH_ARGV", "BASH_SOURCE", "BASH_LINENO", "BASH_VERSINFO",
  "BASH_VERSION", "BASH_ALIASES", "BASH_ARGC", "BASH_ARGV0", "BASH_COMMAND",
  "BASH_ENV", "BASH_SUBSHELL", "BASH_XTRACEFD", "HISTFILE", "HISTSIZE",
  "HISTFILESIZE", "HISTCONTROL", "LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES",
  "TERM", "ENV", "CDPATH", "PROMPT_COMMAND", "TIMEFORMAT", "TMOUT",
  "GLOBIGNORE", "INPUTRC", "OPTERR", "OPTIND", "OPTARG", "REPLY",
  "COMP_WORDBREAKS", "COMPREPLY", "BASH_COMPLETION_VERSINFO",
]);

export function isSystemVar(name) {
  if (name === "") return true;
  if (name.startsWith("BASH")) return true;
  if (name.startsWith("COMP_")) return true;
  if (name.startsWith("__bt")) return true;
  return SYSTEM_VARS.has(name);
}

function unescape(str) {
  return str.replace(/\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{4}|[0-7]{1,3}|.)/g, (m, e) => {
    switch (e[0]) {
      case "n": return "\n";
      case "t": return "\t";
      case "r": return "\r";
      case "a": return "\x07";
      case "v": return "\x0b";
      case "f": return "\x0c";
      case "e": return "\x1b";
      case "\\": return "\\";
      case '"': return '"';
      case "$": return "$";
      case "`": return "`";
      case "'": return "'";
      case "x": return String.fromCharCode(parseInt(e.slice(1), 16));
      case "u": return String.fromCodePoint(parseInt(e.slice(1), 16));
      default: return /^\d+$/.test(e) ? String.fromCharCode(parseInt(e, 8)) : e;
    }
  });
}

function parseQuotedValue(v) {
  if (v.startsWith('"')) return unescape(v.slice(1, -1));
  return v;
}

function parsePairs(body) {
  const re = /\[((?:[^"\\]|\\.)*)\]="((?:[^"\\]|\\.)*)"/g;
  const pairs = [];
  let m;
  while ((m = re.exec(body)) !== null) {
    pairs.push([unescape(m[1]), unescape(m[2])]);
  }
  return pairs;
}

function parseDeclareLine(line) {
  const m = /^declare\s+(-[A-Za-z]+|--)\s+([^=]+)=(.*)$/.exec(line);
  if (!m) return null;
  const flags = m[1];
  const name = m[2].trim();
  const raw = m[3];
  let kind = "string";
  if (flags.includes("a")) kind = "array";
  else if (flags.includes("A")) kind = "assoc";
  else if (flags.includes("i")) kind = "int";
  let value;
  if (kind === "array") {
    value = parsePairs(raw.slice(1, -1));
    value.sort((a, b) => Number(a[0]) - Number(b[0]));
  } else if (kind === "assoc") {
    value = parsePairs(raw.slice(1, -1));
  } else {
    value = parseQuotedValue(raw);
  }
  return {
    name,
    kind,
    readonly: flags.includes("r"),
    exported: flags.includes("x"),
    value,
  };
}

export function parseDeclareP(output) {
  const vars = {};
  for (const line of output.split("\n")) {
    const v = parseDeclareLine(line);
    if (v && !isSystemVar(v.name)) {
      vars[v.name] = v;
    }
  }
  return vars;
}

export function filterUserVars(vars) {
  const out = {};
  for (const [k, v] of Object.entries(vars)) {
    if (!isSystemVar(k)) out[k] = v;
  }
  return out;
}
