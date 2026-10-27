import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { useProviderSkills } from '@/modules/skills/hooks/useProviderSkills';
import { api } from '@/shared/api';
import type { WorkspaceDescriptor } from '@/shared/types';
import type * as AuthTokenModule from '@/shared/authToken';
import type * as ChisaModule from '@/shared/chisa';

const identity = vi.hoisted(() => ({ auth: 0, server: 0 }));
vi.mock('@/shared/authToken', async original => ({ ...await original<typeof AuthTokenModule>(), getAuthSessionVersion: () => identity.auth }));
vi.mock('@/shared/chisa', async original => ({ ...await original<typeof ChisaModule>(), getServerConnectionVersion: () => identity.server }));
beforeEach(() => { identity.auth += 1; });

const replica: WorkspaceDescriptor = {
  projectId: 'project-skills', workspaceId: 'replica:project-skills', generation: 'current', kind: 'cloudReplica',
  rootPath: '/replica/skills', sourceRoot: '/replica/skills', requestedMode: 'isolated', effectiveMode: 'shared',
  phase: 'idle', publicationState: 'integrated',
  capabilities: { read: true, write: true, git: true, shell: true, preview: true, integrate: false, cloudExecutionIndependentOfDesktop: false },
};
afterEach(() => vi.restoreAllMocks());

test('skills settings resolves each project replica and preserves global discovery', async () => {
  const resolve = vi.spyOn(api.workspaces, 'resolve').mockResolvedValue(Response.json({ cloudReplica: replica, session: null }));
  const skills = vi.spyOn(api.providers, 'skills').mockImplementation(async () => Response.json({ success: true, data: { provider: 'claude', skills: [] } }));
  const { result } = renderHook(() => useProviderSkills({ selectedProvider: 'claude', currentProjects: [{ projectId: replica.projectId, path: replica.rootPath, displayName: 'Skills project' }] }));
  await waitFor(() => expect(skills).toHaveBeenCalledTimes(2));
  expect(resolve).toHaveBeenCalledWith(replica.projectId, undefined, { signal: expect.any(AbortSignal) });
  expect(skills.mock.calls[0]).toEqual(['claude', undefined, { signal: expect.any(AbortSignal) }]);
  expect(skills.mock.calls[1]).toEqual(['claude', { projectId: replica.projectId, workspaceId: replica.workspaceId, generation: replica.generation }, { signal: expect.any(AbortSignal) }]);
  await waitFor(() => expect(result.current.isLoadingProjectScopes).toBe(false));
  expect(result.current.loadError).toBeNull();
});

test('an unavailable project replica never falls back to path-only skills', async () => {
  vi.spyOn(api.workspaces, 'resolve').mockResolvedValue(Response.json({ error: 'unavailable' }, { status: 503 }));
  const skills = vi.spyOn(api.providers, 'skills').mockImplementation(async () => Response.json({ success: true, data: { provider: 'claude', skills: [] } }));
  const { result } = renderHook(() => useProviderSkills({ selectedProvider: 'claude', currentProjects: [{ projectId: 'unavailable-skills', path: '/unavailable/skills', displayName: 'Unavailable' }] }));
  await waitFor(() => expect(result.current.loadError).not.toBeNull());
  expect(skills.mock.calls).toEqual([['claude', undefined, { signal: expect.any(AbortSignal) }]]);
});

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const success = (command: string) => Response.json({ success: true, data: { provider: 'claude', skills: [{ name: command, command, scope: 'user' }] } });

test('twenty new project arrays do not reload stable skill targets and an explicit refresh resolves the new generation', async () => {
  let generation = 'first';
  const resolve = vi.spyOn(api.workspaces, 'resolve').mockImplementation(async () => Response.json({ cloudReplica: { ...replica, generation }, session: null }));
  const skills = vi.spyOn(api.providers, 'skills').mockImplementation(async () => success('/current'));
  const { result, rerender } = renderHook(() => useProviderSkills({ selectedProvider: 'claude', currentProjects: [{ projectId: replica.projectId, path: replica.rootPath, displayName: 'Stable' }] }));
  await waitFor(() => expect(result.current.isLoadingProjectScopes).toBe(false));
  await waitFor(() => expect(skills).toHaveBeenCalledTimes(2));
  for (let index = 0; index < 20; index += 1) act(() => rerender());
  expect(skills).toHaveBeenCalledTimes(2);
  expect(resolve).toHaveBeenCalledTimes(1);
  generation = 'second';
  await act(async () => { await result.current.refreshSkills({ force: true }); });
  expect(skills).toHaveBeenCalledTimes(4);
  expect(skills.mock.calls[3][1]).toEqual(expect.objectContaining({ generation: 'second' }));
});

test('account and server changes cannot reuse another identity catalogue cache', async () => {
  let command = '/account-a';
  const skills = vi.spyOn(api.providers, 'skills').mockImplementation(async () => success(command));
  const { result, rerender } = renderHook(() => useProviderSkills({ selectedProvider: 'claude', currentProjects: [] }));
  await waitFor(() => expect(result.current.skills[0]?.command).toBe('/account-a'));
  command = '/account-b'; identity.auth += 1; rerender();
  expect(result.current.skills).toHaveLength(0);
  await waitFor(() => expect(result.current.skills[0]?.command).toBe('/account-b'));
  command = '/server-b'; identity.server += 1; rerender();
  await waitFor(() => expect(result.current.skills[0]?.command).toBe('/server-b'));
  expect(skills).toHaveBeenCalledTimes(3);
});

test('unmount aborts a pending replica resolution and prevents a late result starting project skill discovery', async () => {
  const resolution = deferred<Response>();
  const resolve = vi.spyOn(api.workspaces, 'resolve').mockReturnValueOnce(resolution.promise);
  const skills = vi.spyOn(api.providers, 'skills').mockImplementation(async () => success('/global'));
  const view = renderHook(() => useProviderSkills({ selectedProvider: 'claude', currentProjects: [{ projectId: replica.projectId, path: replica.rootPath }] }));
  await waitFor(() => expect(resolve).toHaveBeenCalledOnce());
  const signal = resolve.mock.calls[0][2]?.signal;
  view.unmount();
  expect(signal?.aborted).toBe(true);
  await act(async () => { resolution.resolve(Response.json({ cloudReplica: replica, session: null })); });
  expect(skills).toHaveBeenCalledTimes(1);
});

 test('a late old-identity body cannot replace or seed the current skill catalogue', async () => {
  const body = deferred<{ success: true; data: { skills: { name: string; command: string }[] } }>();
  const old = success('/late-a');
  vi.spyOn(old, 'json').mockReturnValueOnce(body.promise);
  const skills = vi.spyOn(api.providers, 'skills').mockResolvedValueOnce(old).mockImplementation(async () => success('/current-b'));
  const { result, rerender } = renderHook(() => useProviderSkills({ selectedProvider: 'claude', currentProjects: [] }));
  await act(async () => {});
  identity.auth += 1; rerender();
  await waitFor(() => expect(result.current.skills[0]?.command).toBe('/current-b'));
  await act(async () => { body.resolve({ success: true, data: { skills: [{ name: 'Old', command: '/late-a' }] } }); });
  expect(skills.mock.calls[0][2]?.signal?.aborted).toBe(true);
  expect(result.current.skills.map(skill => skill.command)).toEqual(['/current-b']);
});
