import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express, { type RequestHandler } from 'express';
import multer from 'multer';

import { createFileTreeRouter } from '@/modules/file-tree/file-tree.routes.js';
import { workspaceRequestSignal } from '@/modules/workspace-bridge/index.js';
import type { FileTreeServices } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

function createFakeServices(overrides: Partial<FileTreeServices> = {}): FileTreeServices {
  const unexpectedOperation = async (): Promise<never> => {
    throw new Error('Unexpected File Tree service call');
  };

  return {
    browseWorkspace: unexpectedOperation,
    createWorkspaceFolder: unexpectedOperation,
    readTextFile: unexpectedOperation,
    openFile: unexpectedOperation,
    saveTextFile: unexpectedOperation,
    listProjectFiles: unexpectedOperation,
    createEntry: unexpectedOperation,
    renameEntry: unexpectedOperation,
    deleteEntry: unexpectedOperation,
    storeUploadedFiles: unexpectedOperation,
    ...overrides,
  };
}

const passUploadRequest: RequestHandler = (_request, _response, next) => next();

test('multipart upload route retains selection and request cancellation contexts through multer', async () => {
  const selections = new AsyncLocalStorage<string>();
  let serviceCalls = 0;
  const services = createFakeServices({
    storeUploadedFiles: async input => {
      serviceCalls += 1;
      assert.equal(selections.getStore(), 'workspace-1');
      assert.ok(workspaceRequestSignal() instanceof AbortSignal);
      assert.equal(workspaceRequestSignal()?.aborted, false);
      assert.equal(input.projectId, 'project-1');
      assert.equal(input.files.length, 1);
      assert.equal(input.files[0].originalName, 'uploaded.txt');
      return { success: true, uploadedCount: 1, requestedFileCount: 1, files: [], targetPath: '/selected-root', message: 'uploaded' };
    },
  });
  await withFileTreeServer(services, async baseUrl => {
    const body = new FormData();
    body.append('files', new Blob(['content']), 'uploaded.txt');
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files/upload`, { method: 'POST', body });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { uploadedCount: number }).uploadedCount, 1);
  }, {
    selectionScope: (_request, _response, next) => selections.run('workspace-1', next),
    uploadMiddleware: multer({ storage: multer.memoryStorage() }).array('files'),
  });
  assert.equal(serviceCalls, 1);
  assert.equal(selections.getStore(), undefined);
  assert.equal(workspaceRequestSignal(), undefined);
});

async function withFileTreeServer(
  services: FileTreeServices,
  run: (baseUrl: string) => Promise<void>,
  options: { selectionScope?: RequestHandler; uploadMiddleware?: RequestHandler } = {},
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/file-tree', createFileTreeRouter(
    services,
    options.uploadMiddleware ?? passUploadRequest,
    { maximumFileSizeMegabytes: 200, maximumFileCount: 20 },
    { error: () => undefined },
    options.selectionScope,
  ));

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test('editor save route forwards the loaded hash and rejects malformed hashes', async () => {
  const inputs: Parameters<FileTreeServices['saveTextFile']>[] = [];
  const services = createFakeServices({ saveTextFile: async (...input) => {
    inputs.push(input);
    return { success: true, path: 'main.ts', message: 'saved', hash: 'saved-version' };
  } });
  await withFileTreeServer(services, async baseUrl => {
    const endpoint = `${baseUrl}/api/file-tree/projects/project/file`;
    const response = await fetch(endpoint, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filePath: 'main.ts', content: 'edited', expectedHash: 'loaded-version' }) });
    assert.equal(response.status, 200);
    const invalid = await fetch(endpoint, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filePath: 'main.ts', content: 'edited', expectedHash: { malicious: true } }) });
    assert.equal(invalid.status, 400);
  });
  assert.deepEqual(inputs, [['project', 'main.ts', 'edited', 'loaded-version']]);
});

test('project files route uses the File Tree API namespace and forwards the project id', async () => {
  const inputs: Parameters<FileTreeServices['listProjectFiles']>[] = [];
  const services = createFakeServices({
    listProjectFiles: async (...input) => {
      inputs.push(input);
      return [];
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), []);
  });

  assert.deepEqual(inputs, [['project-1', { respectGitignore: false }]]);
});

test('project files route requests gitignore filtering when explicitly enabled', async () => {
  const inputs: Parameters<FileTreeServices['listProjectFiles']>[] = [];
  const services = createFakeServices({
    listProjectFiles: async (...input) => {
      inputs.push(input);
      return [];
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/file-tree/projects/project-1/files?respectGitignore=true`,
    );

    assert.equal(response.status, 200);
  });

  assert.deepEqual(inputs, [['project-1', { respectGitignore: true }]]);
});

test('project files route preserves workspace unavailable status and message', async () => {
  const services = createFakeServices({
    listProjectFiles: async () => {
      throw new AppError('Workspace connection unavailable', { code: 'WORKSPACE_UNAVAILABLE', statusCode: 503 });
    },
  });
  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'Workspace connection unavailable', code: 'WORKSPACE_UNAVAILABLE' });
  });
});

test('project files route forwards shallow directory selection while preserving the node array response', async () => {
  const inputs: Parameters<FileTreeServices['listProjectFiles']>[] = [];
  const services = createFakeServices({
    listProjectFiles: async (...input) => { inputs.push(input); return []; },
  });
  await withFileTreeServer(services, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files?respectGitignore=true&shallow=true&directoryPath=${encodeURIComponent('/workspace/project/vendor')}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), []);
  });
  assert.deepEqual(inputs, [['project-1', { respectGitignore: true, shallow: true, directoryPath: '/workspace/project/vendor' }]]);
});

test('create route parses the transport payload before invoking the service', async () => {
  const inputs: Parameters<FileTreeServices['createEntry']>[0][] = [];
  const services = createFakeServices({
    createEntry: async (input) => {
      inputs.push(input);
      return {
        success: true,
        path: '/workspace/project/src/example.ts',
        name: input.name,
        type: input.type,
        message: 'File created successfully',
      };
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: '/workspace/project/src',
        type: 'file',
        name: 'example.ts',
      }),
    });

    assert.equal(response.status, 200);
  });

  assert.deepEqual(inputs, [{
    projectId: 'project-1',
    parentPath: '/workspace/project/src',
    type: 'file',
    name: 'example.ts',
  }]);
});

test('create route rejects invalid entry types without calling the service', async () => {
  let createCalled = false;
  const services = createFakeServices({
    createEntry: async () => {
      createCalled = true;
      throw new Error('createEntry should not run for invalid input');
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'link', name: 'example' }),
    });
    const payload = await response.json() as { error: string };

    assert.equal(response.status, 400);
    assert.equal(payload.error, 'Type must be "file" or "directory"');
  });

  assert.equal(createCalled, false);
});
