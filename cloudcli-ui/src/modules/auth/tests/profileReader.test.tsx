import assert from 'node:assert/strict';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { AccountProfileEditor } from '@/modules/auth/AccountProfileEditor';

const actions = vi.hoisted(() => ({ updateProfile: vi.fn(), logout: vi.fn() }));
vi.mock('@/modules/auth/context/AuthContext', () => ({ useAuth: () => ({ user: { username: 'demo-user', avatarDataUrl: 'data:image/png;base64,old' }, ...actions }) }));
class AvatarReader {
  static readers: AvatarReader[] = [];
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  abort = vi.fn();
  constructor() { AvatarReader.readers.push(this); }
  readAsDataURL() {}
  finish(value: string) { this.result = value; this.onload?.(); }
}
beforeEach(() => {
  vi.resetAllMocks(); AvatarReader.readers = [];
  vi.stubGlobal('FileReader', AvatarReader);
  actions.updateProfile.mockResolvedValue({ success: true });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('only the current avatar reader can become a persistable preview', async () => {
  const view = render(<AccountProfileEditor />);
  const picker = screen.getByLabelText('选择账户头像');
  fireEvent.change(picker, { target: { files: [new File(['a'], 'a.png', { type: 'image/png' })] } });
  fireEvent.submit(view.container.querySelector('form')!);
  assert.equal(actions.updateProfile.mock.calls.length, 0);
  assert.equal((screen.getByRole('button', { name: '读取头像中…' }) as HTMLButtonElement).disabled, true);
  fireEvent.change(picker, { target: { files: [new File(['b'], 'b.png', { type: 'image/png' })] } });
  assert.equal(AvatarReader.readers[0].abort.mock.calls.length, 1);
  act(() => AvatarReader.readers[1].finish('data:image/png;base64,new'));
  act(() => AvatarReader.readers[0].finish('data:image/png;base64,stale'));
  assert.equal(view.container.querySelector('img')?.getAttribute('src'), 'data:image/png;base64,new');
  await act(async () => { fireEvent.submit(view.container.querySelector('form')!); });
  assert.deepEqual(actions.updateProfile.mock.calls, [['demo-user', 'data:image/png;base64,new']]);
});

test('unmount aborts the reader and ignores its late preview', () => {
  const view = render(<AccountProfileEditor />);
  fireEvent.change(screen.getByLabelText('选择账户头像'), { target: { files: [new File(['a'], 'a.png', { type: 'image/png' })] } });
  view.unmount();
  assert.equal(AvatarReader.readers[0].abort.mock.calls.length, 1);
  act(() => AvatarReader.readers[0].finish('data:image/png;base64,late'));
  assert.equal(actions.updateProfile.mock.calls.length, 0);
});
