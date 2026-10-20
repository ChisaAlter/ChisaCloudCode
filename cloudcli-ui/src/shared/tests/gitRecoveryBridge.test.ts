import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { ChisaGitRecoveryResponse } from '@/shared/types';

const native = vi.hoisted(() => ({ call: vi.fn(), on: vi.fn() }));
vi.mock('mygo-runtime', () => native);
import { FrontendBridge } from '@/shared/chisa';
import { getBlockingOperations } from '@/shared/utils';

const PROJECT = '/srv/project-a';

beforeEach(() => { vi.resetAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

test('Git recovery preview passes its binding and returns the observation without starting synchronization', async () => {
  const response: ChisaGitRecoveryResponse = { ok: true, recovery: {
    token: 'review-token', serverPath: PROJECT, bindingEpoch: 'binding-a',
    local: { branch: 'main', head: 'local-head', staged: true, operation: '' },
    remote: { branch: 'feature', head: 'remote-head', staged: false, operation: 'rebase' },
    localAllowed: true, localReason: '', remoteAllowed: false, remoteReason: 'rebase in progress',
  } };
  native.call.mockResolvedValueOnce(response);
  expect(await FrontendBridge.getProjectGitRecovery(PROJECT, 'binding-a')).toEqual(response);
  expect(native.call).toHaveBeenCalledExactlyOnceWith('FrontendBridge.GetProjectGitRecovery', PROJECT, 'binding-a');
  expect(getBlockingOperations()).toEqual([]);
});

test.each(['local', 'remote'] as const)('Git recovery confirms the exact token, epoch and %s authority', async source => {
  const result = { ok: false, code: 'GIT_RECOVERY_STALE', error: 'Git state changed' };
  native.call.mockResolvedValueOnce(result);
  expect(await FrontendBridge.recoverProjectGit(PROJECT, 'binding-a', 'review-token', source)).toEqual(result);
  expect(native.call).toHaveBeenCalledExactlyOnceWith('FrontendBridge.RecoverProjectGit', PROJECT, 'binding-a', 'review-token', source);
  expect(getBlockingOperations()).toEqual([]);
});
