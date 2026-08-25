import * as ParserNS from "web-tree-sitter";

const Parser = ParserNS.Parser;

let parser = null;
let lang = null;

export async function initParser(grammarPathOrUrl, coreWasmUrl) {
  if (!parser) {
    if (coreWasmUrl) {
      await Parser.init({ locateFile: () => coreWasmUrl });
    } else {
      await Parser.init();
    }
    parser = new Parser();
    lang = await ParserNS.Language.load(grammarPathOrUrl);
    parser.setLanguage(lang);
  }
  return parser;
}

const STEP_TYPES = new Set([
  "command",
  "variable_assignment",
  "declaration_command",
  "pipeline",
  "list",
]);

const SKIP_TYPES = new Set([
  "function_definition",
  "command_substitution",
  "process_substitution",
  "subshell",
]);

function walkSteps(node, out) {
  if (SKIP_TYPES.has(node.type)) return;
  if (STEP_TYPES.has(node.type)) {
    out.push({
      startIndex: node.startIndex,
      endIndex: node.endIndex,
      startLine: node.startPosition.row,
      endLine: node.endPosition.row,
      type: node.type,
    });
    return;
  }
  for (const c of node.namedChildren) walkSteps(c, out);
}

export function findStepNodes(script) {
  const tree = parser.parse(script);
  const root = tree.rootNode;
  const steps = [];
  walkSteps(root, steps);
  return { steps, hasError: root.hasError };
}

export function splitTopLevel(script) {
  const tree = parser.parse(script);
  const root = tree.rootNode;
  const nodes = [];
  (function collect(n) {
    if (n.type === "comment") return;
    if (n.type === "program" || n.type === "translation_unit") {
      for (const c of n.namedChildren) collect(c);
      return;
    }
    nodes.push(n);
  })(root);
  return {
    hasError: root.hasError,
    statements: nodes.map((n) => ({
      text: n.text,
      startLine: n.startPosition.row,
      endLine: n.endPosition.row,
      type: n.type,
    })),
  };
}

export function firstErrorLine(script) {
  const tree = parser.parse(script);
  const root = tree.rootNode;
  if (!root.hasError) return null;
  const errors = [];
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (n.type === "ERROR" || n.isMissing) {
      errors.push({ n, row: n.startPosition.row });
    }
    for (const c of n.children) stack.push(c);
  }
  if (!errors.length) return null;
  errors.sort((a, b) => a.row - b.row || b.n.endPosition.row - a.n.endPosition.row);
  const node = errors[0].n;
  const lines = node.text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== "") return node.startPosition.row + i + 1;
  }
  return node.startPosition.row + 1;
}
