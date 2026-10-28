import { EditorView, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightActiveLine, keymap, Decoration } from "@codemirror/view";
import { Compartment, EditorState, StateEffect, StateField } from "@codemirror/state";
import { history, defaultKeymap, historyKeymap } from "@codemirror/commands";
import { StreamLanguage, indentOnInput, syntaxHighlighting, defaultHighlightStyle, bracketMatching, foldKeymap } from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { oneDark } from "@codemirror/theme-one-dark";

const setMarks = StateEffect.define();

const markField = StateField.define({
  create: () => Decoration.none,
  update(marks, tr) {
    let next = marks.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setMarks)) next = effect.value;
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const themeCompartment = new Compartment();

const baseTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "13px" },
  ".cm-scroller": { fontFamily: "'JetBrains Mono', Consolas, monospace" },
  "&.cm-focused": { outline: "none" },
});

function setup() {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    bracketMatching(),
    closeBrackets(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
    ]),
  ];
}

function marksFor(view, currentLine, errorLine) {
  const doc = view.state.doc;
  const ranges = [];
  if (currentLine >= 1 && currentLine <= doc.lines) {
    ranges.push(Decoration.line({ class: "cm-current-line" }).range(doc.line(currentLine).from));
  }
  if (errorLine >= 1 && errorLine <= doc.lines) {
    ranges.push(Decoration.line({ class: "cm-error-line" }).range(doc.line(errorLine).from));
  }
  return Decoration.set(ranges, true);
}

export function createEditor(container, initialDoc, { onChange } = {}) {
  return new EditorView({
    parent: container,
    doc: initialDoc,
    extensions: [
      setup(),
      StreamLanguage.define(shell),
      baseTheme,
      markField,
      themeCompartment.of([]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && onChange) onChange(update.state.doc.toString());
      }),
    ],
  });
}

export function setEditorDoc(view, doc) {
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc } });
}

export function highlightLines(view, currentLine, errorLine, reveal = false) {
  const effects = [setMarks.of(marksFor(view, currentLine, errorLine))];
  const doc = view.state.doc;
  if (reveal && currentLine >= 1 && currentLine <= doc.lines) {
    effects.push(EditorView.scrollIntoView(doc.line(currentLine).from, { y: "center" }));
  }
  view.dispatch({ effects });
}

export function clearHighlights(view) {
  view.dispatch({ effects: setMarks.of(Decoration.none) });
}

export function setEditorTheme(view, dark) {
  view.dispatch({ effects: themeCompartment.reconfigure(dark ? oneDark : []) });
}
