import assert from 'node:assert/strict';

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import { useFileOpenResolver } from '@/modules/project-workspace/hooks/useFileOpenResolver';

const requests = vi.hoisted(() => ({ getFiles: vi.fn() }));
vi.mock('@/shared/api', () => ({ api: requests }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

test('explicit absolute path is not replaced by an active-project basename match', () => {
  const open = vi.fn();
  const { result } = renderHook(() => useFileOpenResolver({ projectId: 'agentmux', displayName: 'agentmux', fullPath: '/srv/agentmux' }, open));
  act(() => result.current('/tmp/frames/after-140x38.png'));
  assert.equal(open.mock.calls[0][0], '/tmp/frames/after-140x38.png');
  assert.equal(requests.getFiles.mock.calls.length, 0);
});

test('relative references still resolve against the active project tree', async () => {
  requests.getFiles.mockResolvedValue(new Response(JSON.stringify([{ type: 'file', name: 'main.ts', path: '/srv/agentmux/src/main.ts' }])));
  const open = vi.fn();
  const { result } = renderHook(() => useFileOpenResolver({ projectId: 'agentmux', displayName: 'agentmux', fullPath: '/srv/agentmux' }, open));
  await act(async () => result.current('main.ts'));
  assert.equal(open.mock.calls[0][0], '/srv/agentmux/src/main.ts');
});
