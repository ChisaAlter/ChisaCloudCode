import assert from 'node:assert/strict';
import { mkdtemp, access, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runProviderProcess } from '@/modules/providers/services/provider-process.service.js';

test('cancellation during worker ownership handshake never dispatches a CLI and confirms empty teardown', { timeout: 20_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'provider-prelaunch-cancel-'));
  const marker = path.join(root, 'unexpected-launch');
  const cancellation = new AbortController();
  try {
    const running = runProviderProcess({ kind: 'cli', command: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unsafe')`], cwd: root }, {}, cancellation.signal);
    cancellation.abort();
    await assert.rejects(running, (error: unknown) => {
      assert.equal((error as Error).name, 'AbortError');
      assert.equal((error as { processTeardownError?: boolean }).processTeardownError, undefined);
      return true;
    });
    await assert.rejects(access(marker), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
