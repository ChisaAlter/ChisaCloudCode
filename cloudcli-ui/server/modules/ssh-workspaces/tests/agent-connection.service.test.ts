import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { agentConnectionService } from '@/modules/ssh-workspaces/index.js';
import { AppError } from '@/shared/index.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'agent-connection-service-'));
  const databasePath = path.join(tempDirectory, 'auth.db');
  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  try {
    await writeFile(databasePath, '');
    await initializeDatabase();
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('agent connection service validates ids, names, ports and ownership', async () => {
  await withIsolatedDatabase(() => {
    const saved = agentConnectionService.upsert('1', { id: 'desktop-one', name: ' Windows desktop ', port: 18765, token: 'a'.repeat(64) });
    assert.equal(saved.name, 'Windows desktop');
    assert.equal(agentConnectionService.list('1').length, 1);
    assert.equal(agentConnectionService.list('2').length, 0);
    for (const body of [
      { id: '../escape', name: 'x', port: 18765, token: 'a'.repeat(64) },
      { id: 'desktop-two', name: '', port: 18765, token: 'a'.repeat(64) },
      { id: 'desktop-two', name: 'x', port: 22, token: 'a'.repeat(64) },
      { id: 'desktop-two', name: 'x', port: 70000, token: 'a'.repeat(64) },
      { id: 'desktop-two', name: 'x', port: 18765, token: 'bad' },
      { id: 'desktop-two', name: 'x', port: 18765 },
      { id: 'desktop-two', name: 'x', port: 18765, token: 'a'.repeat(63) },
      { id: 'desktop-two', name: 'x', port: 18765, token: 'a'.repeat(65) },
      { id: 'desktop-two', name: 'x', port: 18765, token: 'a'.repeat(63) + '\n' },
      { id: 'desktop-two', name: 'x', port: 18765, token: 'a'.repeat(64) + '\n' },
      { id: 'desktop-two', name: 'x', port: 18765, token: 'a'.repeat(64), delivery: 'https://remote' },
      { id: 'desktop-two', name: 'secret ' + 'a'.repeat(64), port: 18765, token: 'a'.repeat(64) },
      { id: 'a'.repeat(64), name: 'x', port: 18765, token: 'a'.repeat(64) },
    ]) {
      assert.throws(() => agentConnectionService.upsert('1', body), (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, 'INVALID_AGENT_CONNECTION');
        return true;
      });
    }
    assert.throws(() => agentConnectionService.remove('2', 'desktop-one'), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'AGENT_CONNECTION_NOT_FOUND');
      return true;
    });
    const isolated = agentConnectionService.upsert('2', { id: 'desktop-one', name: 'Other owner', port: 18766, token: 'b'.repeat(64), delivery: 'relay' });
    assert.equal(isolated.delivery, 'relay');
    assert.equal(agentConnectionService.list('1')[0]?.port, 18765);
    assert.equal(agentConnectionService.list('2')[0]?.port, 18766);
    for (const owner of ['', '\n', 'a'.repeat(257)]) {
      assert.throws(() => agentConnectionService.upsert(owner, { id: 'x', name: 'x', port: 18765, token: 'a'.repeat(64) }), { code: 'UNAUTHORIZED' });
      assert.throws(() => agentConnectionService.list(owner), { code: 'UNAUTHORIZED' });
      assert.throws(() => agentConnectionService.remove(owner, 'desktop-one'), { code: 'UNAUTHORIZED' });
    }
    agentConnectionService.remove('1', 'desktop-one');
    assert.equal(agentConnectionService.list('1').length, 0);
  });
});
