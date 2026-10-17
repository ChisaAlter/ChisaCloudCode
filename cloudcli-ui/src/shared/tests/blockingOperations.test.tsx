import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { BlockingOperationDialog } from '@/shared/ui/BlockingOperationDialog';
import { beginBackgroundOperation, beginBlockingOperation, getBlockingOperations, withBlockingOperation } from '@/shared/utils';

vi.mock('@/shared/chisa', () => ({ subscribeWorkspaceSynchronization: () => () => {} }));
afterEach(cleanup);

test('loading blocks background controls and shortcuts and cannot be dismissed', () => {
  render(<><button>Background action</button><BlockingOperationDialog /></>);
  screen.getByRole('button').focus();
  const backgroundKey = vi.fn();
  document.addEventListener('keydown', backgroundKey);
  let finish!: () => void;
  act(() => { finish = beginBlockingOperation('正在停止任务', '正在同步工作区…'); });
  const dialog = screen.getByRole('dialog');
  expect(dialog.getAttribute('aria-busy')).toBe('true');
  expect(screen.getByRole('button').closest<HTMLElement>('body > div')?.inert).toBe(true);
  expect(document.activeElement).toBe(dialog);
  fireEvent.keyDown(dialog, { key: 'Escape' });
  fireEvent.keyDown(dialog, { key: 'Tab' });
  expect(backgroundKey).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog')).toBe(dialog);
  act(finish);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('button').closest<HTMLElement>('body > div')?.inert).toBeFalsy();
  expect(document.activeElement).toBe(screen.getByRole('button'));
  document.removeEventListener('keydown', backgroundKey);
});

test('nested operations stay blocked until both finish; rejected operations release the dialog', async () => {
  const outer = beginBlockingOperation('打开工作目录', '等待项目创建');
  const inner = beginBlockingOperation('同步工作区', '等待同步');
  inner();
  expect(getBlockingOperations().map(operation => operation.title)).toEqual(['打开工作目录']);
  outer();
  await expect(withBlockingOperation('同步', '等待同步', async () => { throw new Error('同步失败'); })).rejects.toThrow('同步失败');
  expect(getBlockingOperations()).toEqual([]);
});

test('background sync permits interaction but cannot dismiss a new-directory dialog', () => {
  render(<><input aria-label="Draft" /><BlockingOperationDialog /></>);
  let endSync!: () => void;
  act(() => { endSync = beginBackgroundOperation('后台同步', '可继续操作'); });
  expect(screen.queryByRole('dialog')).toBeNull();
  const input = screen.getByRole('textbox');
  input.focus();
  expect(document.activeElement).toBe(input);
  expect(input.closest<HTMLElement>('body > div')?.inert).toBeFalsy();
  let endDirectory!: () => void;
  act(() => { endDirectory = beginBlockingOperation('新增目录', '准备中'); });
  expect(screen.getByRole('dialog').textContent).toContain('新增目录');
  act(endSync);
  expect(screen.getByRole('dialog')).toBeDefined();
  act(endDirectory);
  expect(screen.queryByRole('dialog')).toBeNull();
});
