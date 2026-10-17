import assert from 'node:assert/strict';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';
import EditorSidebar from '@/modules/code-editor/EditorSidebar';
import type { CodeEditorFile } from '@/shared/types';

const requests = vi.hoisted(() => ({ readFile: vi.fn(), saveFile: vi.fn() }));
vi.mock('@/shared/api', () => ({ api: requests }));
vi.mock('@/modules/code-editor/CodeEditor', async () => {
  const { useCodeEditorDocument } = await import('@/modules/code-editor/hooks/useCodeEditorDocument');
  return { default: function MockCodeEditor({ file, isSidebar, onPopOut }: { file: CodeEditorFile; isSidebar: boolean; onPopOut: () => void }) {
    const document = useCodeEditorDocument({ file });
    return <div><textarea aria-label="buffer" value={document.content} onChange={event => document.setContent(event.target.value)} /><button onClick={onPopOut}>pop out</button><span>{isSidebar ? 'docked' : 'modal'}</span></div>;
  } };
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200);
  requests.readFile.mockResolvedValue(new Response('{"content":"original","hash":"h0"}', { headers: { 'Content-Type': 'application/json' } }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('pop-out and desktop/mobile presentation preserve the same editable document', async () => {
  const props = { editingFile: { path: 'a.ts', name: 'a.ts', projectId: 'project' }, isMobile: false, editorExpanded: false, editorWidth: 400, hasManualWidth: false, resizeHandleRef: { current: null }, onResizeStart: vi.fn(), onCloseEditor: vi.fn(), onToggleEditorExpand: vi.fn() };
  const view = render(<EditorSidebar {...props} />);
  await waitFor(() => assert.equal((screen.getByLabelText('buffer') as HTMLTextAreaElement).value, 'original'));
  const originalNode = screen.getByLabelText('buffer');
  fireEvent.change(originalNode, { target: { value: 'unsaved buffer' } });
  view.rerender(<EditorSidebar {...props} isMobile />);
  assert.equal(screen.getByLabelText('buffer'), originalNode);
  assert.equal((originalNode as HTMLTextAreaElement).value, 'unsaved buffer');
  view.rerender(<EditorSidebar {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'pop out' }));
  assert.equal(screen.getByLabelText('buffer'), originalNode);
  assert.ok(screen.getByText('modal'));
  assert.equal(requests.readFile.mock.calls.length, 1);
});
