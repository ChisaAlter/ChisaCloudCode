import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { useChatProviderState } from '@/modules/chat/hooks/useChatProviderState';
import type { Project } from '@/shared/types';

vi.mock('@/shared/api', () => ({ api: { providers: { models: async () => ({ ok: true, json: async () => ({ success: true, data: null }) }), capabilities: async () => ({ ok: true, json: async () => ({ success: true, data: null }) }) } } }));
vi.mock('@/shared/selectedProvider', () => ({ readSelectedProvider: () => 'codex', writeSelectedProvider: vi.fn() }));
afterEach(() => { cleanup(); localStorage.clear(); });
const cloud: Project = { projectId: 'cloud', displayName: 'Cloud', fullPath: '/cloud' };
const local: Project = { projectId: 'local', displayName: 'Local', fullPath: '/meta/local', sourceMode: 'ssh' };

test('SSH forces Claude without replacing the preferred cloud provider', async () => {
  const { result, rerender } = renderHook(({ project }) => useChatProviderState({ selectedSession: null, selectedProject: project }), { initialProps: { project: cloud } });
  expect(result.current.provider).toBe('codex');
  rerender({ project: local });
  await waitFor(() => expect(result.current.provider).toBe('claude'));
  act(() => result.current.setProvider('codex'));
  expect(result.current.provider).toBe('claude');
  rerender({ project: cloud });
  expect(result.current.provider).toBe('codex');
});
