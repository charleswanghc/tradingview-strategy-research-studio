/** Serialized into TradingView's MAIN world. Keep this function self-contained. */
export function pineEditorOperation(action: string, source = '', expectedSource?: string): Record<string, unknown> {
  const visible = (node: Element | null) => !!node && !!(node as HTMLElement).getClientRects().length;
  const root = document.querySelector('[data-name="pine-editor"], [data-name="pine-editor-container"], #pine-editor')
    || Array.from(document.querySelectorAll('.monaco-editor, .CodeMirror')).find(visible);
  if (!root || !visible(root)) throw new Error('PINE_EDITOR_UNAVAILABLE: Open the Pine Editor on the target chart.');
  const page = window as any;
  const editors = (page.monaco?.editor?.getEditors?.() || []).filter((editor: any) => {
    const node = editor.getDomNode?.();
    return node && visible(node) && (root === node || root.contains(node));
  });
  const codeMirrorNode = root.matches('.CodeMirror') ? root : root.querySelector('.CodeMirror');
  const codeMirror = (codeMirrorNode as any)?.CodeMirror;
  let editor: any;
  let read: () => string;
  let write: (value: string) => void;
  if (editors.length === 1) {
    editor = editors[0];
    const model = editor.getModel();
    if (!model) throw new Error('Pine Editor has no writable model.');
    read = () => model.getValue();
    write = value => {
      editor.pushUndoStop?.();
      editor.executeEdits('tradingview-assistant', [{ range: model.getFullModelRange(), text: value }]);
      editor.pushUndoStop?.();
    };
  } else if (codeMirror?.getValue && codeMirror?.setValue) {
    read = () => codeMirror.getValue(); write = value => codeMirror.setValue(value);
  } else {
    throw new Error('PINE_EDITOR_UNSUPPORTED: A unique Monaco or CodeMirror editor API was not exposed. No code was changed.');
  }
  const current = read();
  if (current.length > 200000) throw new Error('Pine source exceeds the 200,000 character limit.');
  if (action === 'read') return { source: current };
  if (action !== 'write' || !source || source.length > 200000) throw new Error('Invalid Pine editor operation.');
  if (expectedSource === undefined || current.replace(/\r\n/g, '\n') !== expectedSource.replace(/\r\n/g, '\n')) {
    throw new Error('EDITOR_CHANGED: Pine source changed since the last saved version. Read it and start a new research session.');
  }
  write(source);
  if (read().replace(/\r\n/g, '\n') !== source.replace(/\r\n/g, '\n')) throw new Error('Pine source write verification failed.');
  return { written: true };
}
