import { forwardRef, useImperativeHandle, useMemo, useRef } from 'react';
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { EditorView, keymap } from '@codemirror/view';
import { Prec } from '@codemirror/state';
import { sql, PostgreSQL } from '@codemirror/lang-sql';
import { oneDark } from '@codemirror/theme-one-dark';
import { useTheme } from '../../store/theme';

export interface SqlEditorHandle {
  /** Inserts text at the cursor (replacing any selection) and focuses the editor. */
  insert(text: string): void;
  focus(): void;
}

interface Props {
  value: string;
  /** Cursor offset to restore when the editor (re)mounts for a tab. */
  initialCursor?: number;
  onChange: (value: string, cursor: number) => void;
  onCursorChange?: (cursor: number) => void;
  onRun: (selection: string | null) => void;
  schema?: Record<string, string[]>;
}

export const SqlEditor = forwardRef<SqlEditorHandle, Props>(function SqlEditor({ value, initialCursor, onChange, onCursorChange, onRun, schema }, ref) {
  const cm = useRef<ReactCodeMirrorRef>(null);
  const lastCursor = useRef<number>(initialCursor ?? 0);
  const kind = useTheme((t) => t.theme.kind);

  useImperativeHandle(ref, () => ({
    insert(text) {
      const view = cm.current?.view;
      if (!view) return;
      const { from, to } = view.state.selection.main;
      const before = from > 0 ? view.state.sliceDoc(from - 1, from) : '';
      const pad = before && !/[\s(,.]/.test(before) ? ' ' : '';
      view.dispatch({ changes: { from, to, insert: pad + text }, selection: { anchor: from + pad.length + text.length } });
      view.focus();
    },
    focus() {
      cm.current?.view?.focus();
    },
  }));

  const extensions = useMemo(
    () => [
      sql({ dialect: PostgreSQL, schema, upperCaseKeywords: true }),
      EditorView.lineWrapping,
      Prec.highest(
        keymap.of([
          {
            key: 'Mod-Enter',
            run: (view) => {
              const sel = view.state.selection.main;
              onRun(sel.empty ? null : view.state.sliceDoc(sel.from, sel.to));
              return true;
            },
          },
        ]),
      ),
      EditorView.updateListener.of((u) => {
        const head = u.state.selection.main.head;
        if (u.selectionSet && !u.docChanged && head !== lastCursor.current) {
          lastCursor.current = head;
          onCursorChange?.(head);
        }
      }),
      EditorView.theme({ '&': { backgroundColor: 'var(--color-zinc-950)' }, '.cm-scroller': { fontFamily: 'var(--font-mono)' } }),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [schema, onRun, onCursorChange],
  );

  return (
    <CodeMirror
      ref={cm}
      value={value}
      height="100%"
      theme={kind === 'dark' ? oneDark : 'light'}
      extensions={extensions}
      basicSetup={{ foldGutter: false, highlightActiveLine: true, autocompletion: true, bracketMatching: true, closeBrackets: true }}
      onChange={(v, viewUpdate) => {
        const head = viewUpdate.state.selection.main.head;
        lastCursor.current = head;
        onChange(v, head);
      }}
      onCreateEditor={(view) => {
        const pos = Math.min(initialCursor ?? 0, view.state.doc.length);
        view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
      }}
      className="h-full"
      placeholder="-- ⌘/Ctrl+Enter runs the editor contents, or just the selection."
    />
  );
});
