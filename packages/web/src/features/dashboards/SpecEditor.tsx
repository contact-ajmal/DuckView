import { useMemo } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { EditorView, keymap } from '@codemirror/view';
import { Prec } from '@codemirror/state';
import { yaml } from '@codemirror/lang-yaml';
import { json } from '@codemirror/lang-json';
import { oneDark } from '@codemirror/theme-one-dark';
import { useTheme } from '../../store/theme';

/** Text editor for Mosaic specs (YAML or JSON) with Cmd/Ctrl+S wired to save. */
export function SpecEditor({ value, format, onChange, onSave }: { value: string; format: 'yaml' | 'json'; onChange: (v: string) => void; onSave: () => void }) {
  const kind = useTheme((t) => t.theme.kind);
  const extensions = useMemo(
    () => [format === 'json' ? json() : yaml(), EditorView.lineWrapping, Prec.highest(keymap.of([{ key: 'Mod-s', run: () => (onSave(), true) }]))],
    [format, onSave],
  );
  return <CodeMirror value={value} height="100%" theme={kind === 'dark' ? oneDark : 'light'} extensions={extensions} onChange={onChange} basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: true, autocompletion: false }} className="h-full text-xs" />;
}
