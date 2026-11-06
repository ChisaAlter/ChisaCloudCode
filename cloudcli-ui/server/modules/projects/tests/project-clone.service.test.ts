import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { startCloneProject } from '@/modules/projects/services/project-clone.service.js';
import { AppError, WORKSPACES_ROOT } from '@/shared/index.js';

type TestDependencies = Parameters<typeof startCloneProject>[2];

function buildDependencies(overrides: Partial<NonNullable<TestDependencies>> = {}): NonNullable<TestDependencies> {
  return {
    validatePath: async requestedPath => ({ valid: true, resolvedPath: requestedPath }),
    reserveDirectory: async () => undefined,
    ensureDirectory: async () => undefined,
    pathExists: async () => false,
    removePath: async () => undefined,
    getGithubTokenById: async () => ({ github_token: 'token-value' }),
    spawnGitClone: () => {
      throw new Error('spawnGitClone should be overridden in this test');
    },
    registerProject: async () => ({ project: { projectId: 'project-1' } }),
    logError: () => undefined,
    ...overrides,
  };
}

function createMockGitProcess() {
  const emitter = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: () => void;
  };

  emitter.stdout = new PassThrough();
  emitter.stderr = new PassThrough();
  emitter.kill = () => {
    emitter.emit('close', null);
  };

  return emitter;
}

test('startCloneProject rejects when workspace path is missing', async () => {
  await assert.rejects(
    async () =>
      startCloneProject(
        {
          workspacePath: '',
          githubUrl: 'https://github.com/example/repo',
          userId: 1,
        },
        {
          onProgress: () => undefined,
          onComplete: () => undefined,
        },
        buildDependencies(),
      ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'WORKSPACE_PATH_REQUIRED');
      return true;
    },
  );
});

test('startCloneProject rejects when github URL is missing', async () => {
  await assert.rejects(
    async () =>
      startCloneProject(
        {
          workspacePath: '/workspace/root',
          githubUrl: '',
          userId: 1,
        },
        {
          onProgress: () => undefined,
          onComplete: () => undefined,
        },
        buildDependencies(),
      ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'GITHUB_URL_REQUIRED');
      return true;
    },
  );
});

test('startCloneProject rejects github URL values that begin with option prefixes', async () => {
  await assert.rejects(
    async () =>
      startCloneProject(
        {
          workspacePath: '/workspace/root',
          githubUrl: '--upload-pack=malicious',
          userId: 1,
        },
        {
          onProgress: () => undefined,
          onComplete: () => undefined,
        },
        buildDependencies(),
      ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'INVALID_GITHUB_URL');
      return true;
    },
  );
});

test('startCloneProject rejects reserved SSH parents and root-derived target before any mutation or git', async () => {
  const reservedRoot = path.join(WORKSPACES_ROOT, '.chisa-ssh-projects');
  for (const [workspacePath, githubUrl] of [
    [reservedRoot, 'https://github.com/example/repo'],
    [path.join(reservedRoot, 'metadata-id'), 'https://github.com/example/repo'],
    [WORKSPACES_ROOT, 'https://github.com/example/.chisa-ssh-projects.git'],
  ]) {
    const effects: string[] = [];
    await assert.rejects(startCloneProject({ workspacePath, githubUrl, userId: 1 }, {
      onProgress: () => effects.push('progress'),
      onComplete: () => effects.push('complete'),
    }, buildDependencies({
      validatePath: async (requestedPath) => ({ valid: true, resolvedPath: requestedPath }),
      ensureDirectory: async () => { effects.push('mkdir'); },
      spawnGitClone: () => { effects.push('spawn'); throw new Error('Git must not run'); },
      registerProject: async () => { effects.push('register'); return { project: {} }; },
    })), { code: 'SSH_ANCHOR_RESERVED', statusCode: 400 }, workspacePath + ' ' + githubUrl);
    assert.deepEqual(effects, []);
  }
});

test('startCloneProject permits ordinary names beside the reserved namespace', async () => {
  for (const [workspacePath, repoName] of [
    [WORKSPACES_ROOT, '.chisa-ssh-projects-backup'],
    [path.join(WORKSPACES_ROOT, 'ordinary-project'), '.chisa-ssh-projects'],
  ]) {
    const gitProcess = createMockGitProcess();
    let spawnedTarget = '';
    const operation = await startCloneProject({ workspacePath, githubUrl: 'https://github.com/example/' + repoName, userId: 1 }, {
      onProgress: () => undefined,
      onComplete: () => undefined,
    }, buildDependencies({
      validatePath: async (requestedPath) => ({ valid: true, resolvedPath: requestedPath }),
      spawnGitClone: (_url, target) => { spawnedTarget = target; return gitProcess; },
    }));
    gitProcess.emit('close', 0);
    await operation.waitForCompletion;
    assert.equal(spawnedTarget, path.join(workspacePath, repoName));
  }
});

test('startCloneProject rejects canonical clone targets in the SSH metadata tree before mutation', async () => {
  const effects: string[] = [];
  const parent = path.resolve('/workspace/root');
  await assert.rejects(startCloneProject({ workspacePath: parent, githubUrl: 'https://github.com/example/repo', userId: 1 }, {
    onProgress: () => effects.push('progress'),
    onComplete: () => undefined,
  }, buildDependencies({
    validatePath: async (requestedPath) => ({ valid: true, resolvedPath: requestedPath === parent
      ? parent : path.join(WORKSPACES_ROOT, '.chisa-ssh-projects', 'metadata-id') }),
    ensureDirectory: async () => { effects.push('mkdir'); },
    spawnGitClone: () => { effects.push('spawn'); throw new Error('Git must not run'); },
  })), { code: 'SSH_ANCHOR_RESERVED', statusCode: 400 });
  assert.deepEqual(effects, []);
});

test('startCloneProject rejects invalid derived target validation before mutation or git', async () => {
  const calls: string[] = [];
  const workspacePath = path.resolve('/workspace/root');
  const clonePath = path.join(workspacePath, 'repo');
  await assert.rejects(startCloneProject({ workspacePath, githubUrl: 'https://github.com/example/repo', userId: 1 }, {
    onProgress: () => undefined,
    onComplete: () => undefined,
  }, buildDependencies({
    validatePath: async (requestedPath) => {
      calls.push(requestedPath);
      return requestedPath === workspacePath
        ? { valid: true, resolvedPath: workspacePath }
        : { valid: false, error: 'Clone target escapes workspace through a symlink' };
    },
    ensureDirectory: async () => { calls.push('mkdir'); },
    spawnGitClone: () => { calls.push('spawn'); throw new Error('Git must not run'); },
  })), { code: 'INVALID_PROJECT_PATH', statusCode: 400 });
  assert.deepEqual(calls, [workspacePath, clonePath]);
});

test('startCloneProject rejects empty, dot and Windows traversal repository names before mutation', async () => {
  for (const name of ['', '.', '..', '.git', '..git', '...git', '..\\escape', 'nested\\repo', 'repo\0']) {
    const effects: string[] = [];
    // An empty normalized leaf can also be supplied without any repository URL.
    const githubUrl = name === '' ? '/' : 'https://github.com/example/' + name;
    await assert.rejects(startCloneProject({ workspacePath: '/workspace/root', githubUrl, userId: 1 }, {
      onProgress: () => effects.push('progress'),
      onComplete: () => undefined,
    }, buildDependencies({
      ensureDirectory: async () => { effects.push('mkdir'); },
      spawnGitClone: () => { effects.push('spawn'); throw new Error('Git must not run'); },
    })), { code: 'INVALID_GITHUB_URL', statusCode: 400 }, JSON.stringify(name));
    assert.deepEqual(effects, []);
  }
});

test('startCloneProject validates parent and derived target before creating a directory or spawning git', async () => {
  const gitProcess = createMockGitProcess();
  const calls: string[] = [];
  const workspacePath = path.resolve('/workspace/root');
  const clonePath = path.join(workspacePath, 'repo');
  const operation = await startCloneProject({ workspacePath, githubUrl: 'https://github.com/example/repo.git', userId: 1 }, {
    onProgress: () => undefined,
    onComplete: () => undefined,
  }, buildDependencies({
    validatePath: async (requestedPath) => {
      calls.push('validate:' + requestedPath);
      return { valid: true, resolvedPath: requestedPath };
    },
    ensureDirectory: async (directory) => { calls.push('mkdir:' + directory); },
    spawnGitClone: (_url, target) => { calls.push('spawn:' + target); return gitProcess; },
  }));
  gitProcess.emit('close', 0);
  await operation.waitForCompletion;
  assert.deepEqual(calls, ['validate:' + workspacePath, 'validate:' + clonePath, 'mkdir:' + workspacePath, 'spawn:' + clonePath, 'validate:' + clonePath]);
});

for (const [label, githubUrl] of [
  ['a token as the user', 'https://ghp_supersecrettoken1234567890abcd@github.com/example/repo.git'],
  ['a user and password', 'https://user:ghp_supersecrettoken1234567890abcd@github.com/example/repo.git'],
  ['a password on an ssh URL', 'ssh://git:secret@github.com/example/repo.git'],
] as const) {
  test(`startCloneProject rejects a github URL carrying ${label} before git sees it`, async () => {
    // A credential in the URL would ride git's argv, its stderr and the
    // clone's `.git/config` — every channel the token field keeps it out of.
    let spawned = 0;
    await assert.rejects(
      async () =>
        startCloneProject(
          { workspacePath: '/workspace/root', githubUrl, userId: 1 },
          { onProgress: () => undefined, onComplete: () => undefined },
          buildDependencies({ spawnGitClone: () => { spawned += 1; throw new Error('must not spawn'); } }),
        ),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, 'INVALID_GITHUB_URL');
        assert.ok(!error.message.includes('ghp_supersecrettoken'), 'the error must not echo the credential');
        return true;
      },
    );
    assert.equal(spawned, 0);
  });
}

test('startCloneProject rejects an http(s) URL the parser cannot read before git carries it', async () => {
  // 'https://token@github.com:notaport/x' is no URL to the parser, so the
  // credential check could not see the token — and git would have had it on
  // its command line until curl refused the port.
  let spawned = 0;
  await assert.rejects(
    async () =>
      startCloneProject(
        { workspacePath: '/workspace/root', githubUrl: 'https://ghp_supersecrettoken1234567890abcd@github.com:notaport/example/repo.git', userId: 1 },
        { onProgress: () => undefined, onComplete: () => undefined },
        buildDependencies({ spawnGitClone: () => { spawned += 1; throw new Error('must not spawn'); } }),
      ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'INVALID_GITHUB_URL');
      return true;
    },
  );
  assert.equal(spawned, 0);
});

test('startCloneProject accepts the ssh login name that is not a credential', async () => {
  // `git@` on an SSH URL is the login every SSH clone uses, not a secret.
  const gitProcess = createMockGitProcess();
  const operation = await startCloneProject(
    { workspacePath: '/workspace/root', githubUrl: 'ssh://git@github.com/example/repo.git', userId: 1 },
    { onProgress: () => undefined, onComplete: () => undefined },
    buildDependencies({ spawnGitClone: () => gitProcess as never }),
  );
  gitProcess.emit('close', 0);
  await operation.waitForCompletion;
});

test('startCloneProject rejects when selected github token does not exist', async () => {
  await assert.rejects(
    async () =>
      startCloneProject(
        {
          workspacePath: '/workspace/root',
          githubUrl: 'https://github.com/example/repo',
          githubTokenId: 12,
          userId: 1,
        },
        {
          onProgress: () => undefined,
          onComplete: () => undefined,
        },
        buildDependencies({
          getGithubTokenById: async () => null,
        }),
      ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'GITHUB_TOKEN_NOT_FOUND');
      return true;
    },
  );
});

test('startCloneProject completes and emits complete payload when git exits successfully', async () => {
  const gitProcess = createMockGitProcess();
  const progressMessages: string[] = [];
  let completePayload: { project: Record<string, unknown>; message: string } | null = null;
  let capturedProjectPath = '';
  let capturedCustomName = '';

  const operation = await startCloneProject(
    {
      workspacePath: '/workspace/root',
      githubUrl: 'https://github.com/example/repo.git',
      userId: 1,
    },
    {
      onProgress: (message) => {
        progressMessages.push(message);
      },
      onComplete: (payload: { project: Record<string, unknown>; message: string }) => {
        completePayload = payload;
      },
    },
    buildDependencies({
      spawnGitClone: () => gitProcess as any,
      registerProject: async (projectPath, customName) => {
        capturedProjectPath = projectPath;
        capturedCustomName = customName;
        return { project: { projectId: 'project-1', path: projectPath } };
      },
    }),
  );

  gitProcess.emit('close', 0);
  await operation.waitForCompletion;

  assert.ok(progressMessages.some((message) => message.includes("Cloning into 'repo'")));
  assert.equal(capturedCustomName, 'repo');
  assert.equal(path.basename(capturedProjectPath), 'repo');
  assert.notEqual(completePayload, null);
  const resolvedCompletePayload = completePayload as unknown as {
    project: Record<string, unknown>;
    message: string;
  };
  assert.equal(resolvedCompletePayload.message, 'Repository cloned successfully');
  assert.equal((resolvedCompletePayload.project.projectId as string) || '', 'project-1');
});

type SpawnCall = { cloneUrl: string; clonePath: string; environment: NodeJS.ProcessEnv };

/**
 * Runs a clone against a mock git process and captures exactly what would be
 * handed to `spawn`: the URL and path (the only variable argv elements) and
 * the environment. The token has to reach git through the environment alone.
 */
async function captureSpawnCall(input: {
  githubTokenId?: number;
  newGithubToken?: string;
  storedToken?: string;
}): Promise<SpawnCall> {
  const gitProcess = createMockGitProcess();
  let spawnCall: SpawnCall | null = null;

  const operation = await startCloneProject(
    {
      workspacePath: '/workspace/root',
      githubUrl: 'https://github.com/example/repo.git',
      githubTokenId: input.githubTokenId,
      newGithubToken: input.newGithubToken,
      userId: 1,
    },
    {
      onProgress: () => undefined,
      onComplete: () => undefined,
    },
    buildDependencies({
      getGithubTokenById: async () => ({ github_token: input.storedToken ?? 'unused' }),
      spawnGitClone: (cloneUrl, clonePath, environment) => {
        spawnCall = { cloneUrl, clonePath, environment };
        return gitProcess as any;
      },
    }),
  );

  gitProcess.emit('close', 0);
  await operation.waitForCompletion;

  assert.notEqual(spawnCall, null, 'git was never spawned');
  return spawnCall as unknown as SpawnCall;
}

for (const [label, input, token] of [
  ['a stored token', { githubTokenId: 7, storedToken: 'ghp_storedsecret1234567890' }, 'ghp_storedsecret1234567890'],
  // Characters `url.username=` would have percent-encoded, so a check for the
  // raw token alone could not have caught the URL channel.
  ['a new token', { newGithubToken: 'ghp_new:secret@with/odd-chars' }, 'ghp_new:secret@with/odd-chars'],
] as const) {
  test(`startCloneProject hands git ${label} through a scoped environment header, never the clone URL`, async () => {
    const { cloneUrl, clonePath, environment } = await captureSpawnCall(input);

    // The URL git receives is the one the user typed: no username, no password,
    // nothing encoded — so neither argv, stderr nor `.git/config` can carry it.
    assert.equal(cloneUrl, 'https://github.com/example/repo.git');
    assert.equal(clonePath, path.join('/workspace/root', 'repo'));

    assert.equal(environment.CLOUDCLI_GITHUB_TOKEN, undefined);
    assert.equal(environment.GIT_CONFIG_COUNT, '3');
    assert.equal(environment.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader');
    assert.equal(environment.GIT_CONFIG_VALUE_0, 'Authorization: Basic ' + Buffer.from(`x-access-token:${token}`).toString('base64'));
    assert.equal(environment.GIT_CONFIG_KEY_1, 'credential.helper');
    assert.equal(environment.GIT_CONFIG_VALUE_1, '');
    assert.equal(environment.GIT_CONFIG_KEY_2, 'http.followRedirects');
    assert.equal(environment.GIT_CONFIG_VALUE_2, 'false');
    assert.equal(environment.GIT_TERMINAL_PROMPT, '0');

    // The helper's command line is itself a process argv, so the token must be
    // read from the variable rather than pasted into the helper text.
    for (const [name, value] of Object.entries(environment)) {
      if (name === 'CLOUDCLI_GITHUB_TOKEN') {
        continue;
      }
      assert.ok(!(value ?? '').includes(token), `token leaked into ${name}`);
    }
  });
}

test('startCloneProject disables inherited credentials when no token was given', async () => {
  const { cloneUrl, environment } = await captureSpawnCall({});

  assert.equal(cloneUrl, 'https://github.com/example/repo.git');
  assert.equal(environment.GIT_TERMINAL_PROMPT, '0');
  assert.equal(environment.GIT_CONFIG_COUNT, '1');
  assert.equal(environment.GIT_CONFIG_KEY_0, 'credential.helper');
  assert.equal(environment.GIT_CONFIG_VALUE_0, '');
  assert.equal(environment.CLOUDCLI_GITHUB_TOKEN, undefined);
});

/**
 * `git clone --progress` writes every byte of its progress to stderr — stdout
 * stays empty — so these tests drive stderr, the pipe that carries the progress
 * the user watches and the reason a clone failed.
 */
async function runCloneWithStderr(
  chunks: string[],
  exitCode: number | null,
): Promise<{ progressMessages: string[]; failure: AppError | null }> {
  const gitProcess = createMockGitProcess();
  const progressMessages: string[] = [];

  const operation = await startCloneProject(
    {
      workspacePath: '/workspace/root',
      githubUrl: 'https://github.com/example/repo.git',
      newGithubToken: 'ghp_supersecrettoken1234567890abcd',
      userId: 1,
    },
    {
      onProgress: (message) => {
        progressMessages.push(message);
      },
      onComplete: () => undefined,
    },
    buildDependencies({ spawnGitClone: () => gitProcess as any }),
  );

  for (const chunk of chunks) {
    gitProcess.stderr.write(chunk);
  }
  gitProcess.stderr.end();
  // Let the PassThrough deliver every `data` event and its `end` before the
  // process is reported closed, exactly as a real pipe does.
  await new Promise((resolve) => setImmediate(resolve));
  gitProcess.emit('close', exitCode);

  let failure: AppError | null = null;
  try {
    await operation.waitForCompletion;
  } catch (error) {
    failure = error as AppError;
  }

  return { progressMessages, failure };
}

test('startCloneProject forwards each stderr chunk to onProgress as it arrives', async () => {
  const gitProcess = createMockGitProcess();
  const progressMessages: string[] = [];

  const operation = await startCloneProject(
    {
      workspacePath: '/workspace/root',
      githubUrl: 'https://github.com/example/repo.git',
      newGithubToken: 'ghp_supersecrettoken1234567890abcd',
      userId: 1,
    },
    {
      onProgress: (message) => {
        progressMessages.push(message);
      },
      onComplete: () => undefined,
    },
    buildDependencies({ spawnGitClone: () => gitProcess as any }),
  );

  assert.deepEqual(progressMessages, ["Cloning into 'repo'..."]);

  // Each chunk has to surface on its own event before the next one is written
  // and long before the process exits: the progress UI is fed by these events,
  // so anything buffered until close would leave the user staring at nothing.
  const chunks = [
    'remote: Enumerating objects: 20, done.\n',
    'Receiving objects:  45% (9/20)\r',
    'Receiving objects: 100% (20/20), done.\n',
  ];
  for (const [index, chunk] of chunks.entries()) {
    gitProcess.stderr.write(chunk);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      progressMessages,
      ["Cloning into 'repo'...", ...chunks.slice(0, index + 1).map((line) => line.trim())],
      `chunk ${index + 1} did not arrive on its own event`,
    );
  }

  gitProcess.stderr.end();
  gitProcess.emit('close', 0);
  await operation.waitForCompletion;

  assert.deepEqual(progressMessages, [
    "Cloning into 'repo'...",
    'remote: Enumerating objects: 20, done.',
    'Receiving objects:  45% (9/20)',
    'Receiving objects: 100% (20/20), done.',
  ]);
});

test('startCloneProject reports the git failure reason from stderr', async () => {
  const { failure } = await runCloneWithStderr(
    ["remote: Repository not found.\nfatal: repository 'https://github.com/example/repo.git/' not found\n"],
    128,
  );

  assert.equal(failure?.code, 'GIT_CLONE_FAILED');
  assert.equal(failure?.message, 'Repository not found. Please check the URL and ensure you have access.');
});

test('startCloneProject falls back to the last stderr text for an unrecognised failure', async () => {
  const { failure } = await runCloneWithStderr(
    ["fatal: unable to access 'https://github.com/example/repo.git/': SSL error\n"],
    128,
  );

  assert.equal(failure?.code, 'GIT_CLONE_FAILED');
  assert.equal(failure?.message, "fatal: unable to access 'https://github.com/example/repo.git/': SSL error");
});
