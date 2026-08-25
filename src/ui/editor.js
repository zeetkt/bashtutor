import { EditorView, basicSetup } from "codemirror";
import { StreamLanguage } from "@codemirror/language";
import { shell } from "@codemirror/legacy-modes/mode/shell";

export function createEditor(container, initialDoc) {
  const view = new EditorView({
    parent: container,
    doc: initialDoc,
    extensions: [
      basicSetup,
      StreamLanguage.define(shell),
      EditorView.theme({
        "&": { height: "100%", fontSize: "13px" },
        ".cm-scroller": { fontFamily: "'JetBrains Mono', Consolas, monospace" },
      }),
    ],
  });
  return view;
}

export function setEditorDoc(view, doc) {
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc } });
}
