import assert from 'node:assert/strict';

import { afterEach, test, vi } from 'vitest';

import { api } from '@/shared/api';

afterEach(() => vi.unstubAllGlobals());

test('file listings preserve recursive callers and encode the requested shallow folder', async () => {
  const fetchMock = vi.fn<typeof fetch>(async () => ({ headers: { get: () => null } }) as unknown as Response);
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('mygo', undefined);

  await api.getFiles('project-one');
  assert.equal(fetchMock.mock.calls[0][0], '/api/file-tree/projects/project-one/files?respectGitignore=true');

  const controller = new AbortController();
  await api.getFiles('project-one', { shallow: true, directoryPath: '/one/folder with spaces', signal: controller.signal });
  const shallowUrl = new URL(String(fetchMock.mock.calls[1][0]), 'http://localhost');
  assert.equal(shallowUrl.searchParams.get('respectGitignore'), 'true');
  assert.equal(shallowUrl.searchParams.get('shallow'), 'true');
  assert.equal(shallowUrl.searchParams.get('directoryPath'), '/one/folder with spaces');
  assert.equal((fetchMock.mock.calls[1][1] as RequestInit).signal, controller.signal);
  assert.equal(shallowUrl.searchParams.has('signal'), false);
});
