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

const CONDITION_PARENTS = new Map([
  ["if_statement", "condition"],
  ["elif_clause", null],
  ["while_statement", "condition"],
]);

function conditionNode(parent) {
  if (parent.type === "elif_clause") return parent.namedChildren[0] ?? null;
  return parent.childForFieldName(CONDITION_PARENTS.get(parent.type));
}

function stepNode(node, kind) {
  return {
    startIndex: node.startIndex,
    endIndex: node.endIndex,
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    type: node.type,
    kind,
    text: node.text,
  };
}

function walkSteps(node, out) {
  if (SKIP_TYPES.has(node.type)) return;

  const conditionField = CONDITION_PARENTS.get(node.type);
  if (conditionField !== undefined) {
    const condition = conditionNode(node);
    if (condition) out.push(stepNode(condition, "condition"));
    for (const child of node.namedChildren) {
      if (condition && child.equals(condition)) continue;
      walkSteps(child, out);
    }
    return;
  }

  if (STEP_TYPES.has(node.type)) {
    out.push(stepNode(node, "command"));
    return;
  }

  for (const child of node.namedChildren) walkSteps(child, out);
}

export function findStepNodes(script) {
  const tree = parser.parse(script);
  const root = tree.rootNode;
  const steps = [];
  walkSteps(root, steps);
  steps.forEach((step, index) => {
    step.id = index;
  });
  return { steps, hasError: root.hasError };
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
