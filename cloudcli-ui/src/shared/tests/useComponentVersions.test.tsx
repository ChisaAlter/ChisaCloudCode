import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { useComponentVersions } from '@/shared/hooks/useComponentVersions';

const runtime = vi.hoisted(() => ({ account: 0, connection: 0, version: vi.fn(), native: vi.fn() }));
vi.mock('@/shared/api', () => ({ api: { system: { version: runtime.version } } }));
vi.mock('@/shared/authToken', () => ({ AUTH_IDENTITY_CHANGED_EVENT: 'auth-identity-changed', getAuthSessionVersion: () => runtime.account }));
vi.mock('@/shared/chisa', () => ({ SERVER_CONNECTION_CHANGED_EVENT: 'server-connection-changed', getServerConnectionVersion: () => runtime.connection, isDesktop: () => true, FrontendBridge: { getBuildIdentity: runtime.native } }));
afterEach(() => { cleanup(); vi.resetAllMocks(); runtime.account = 0; runtime.connection = 0; });

test('version reads are explicit, read-only, and stale replies cannot repopulate a changed identity', async () => {
  let resolveOld!: (value: Response) => void;
  runtime.version.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }));
  runtime.native.mockResolvedValue({ version: '0.1.6', dirty: true });
  const { result } = renderHook(useComponentVersions);
  expect(runtime.version).not.toHaveBeenCalled();
  let pending!: Promise<void>;
  act(() => { pending = result.current.refresh(); });
  act(() => { runtime.account++; window.dispatchEvent(new Event('auth-identity-changed')); });
  expect(result.current.server.version).toBeNull();
  expect(result.current.loading).toBe(false);
  await act(async () => { resolveOld(new Response(JSON.stringify({ version: '0.1.0' }))); await pending; });
  expect(result.current.server.version).toBeNull();
  runtime.version.mockResolvedValue(new Response(JSON.stringify({ version: '0.1.6', dirty: true, commit: 'b'.repeat(40) })));
  await act(async () => { await result.current.refresh(); });
  expect(result.current.server.version).toBe('0.1.6');
  expect(result.current.server.dirty).toBe(true);
  expect(runtime.version).toHaveBeenCalledTimes(2);
});

test('failed and malformed reads remain explicitly unknown without retry', async () => {
  runtime.version.mockRejectedValue(new Error('/private/key token=secret'));
  runtime.native.mockResolvedValue({ version: '/private/key', commit: 'secret', dirty: null });
  const { result } = renderHook(useComponentVersions);
  await act(async () => { await result.current.refresh(); });
  expect(result.current.server.version).toBeNull();
  expect(result.current.client.version).toBeNull();
  expect(runtime.version).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(result.current)).not.toContain('secret');
});
