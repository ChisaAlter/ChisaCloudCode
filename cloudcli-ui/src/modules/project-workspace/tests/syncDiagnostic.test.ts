import { expect, test } from 'vitest';
import { createSyncDiagnostic } from '@/modules/project-workspace/utils/syncDiagnostic';

test('diagnostics allow only status categories and validated build metadata', () => {
  const secret = 'secret-token /srv/private/account/project C:\\keys\\private.pem';
  const identity = { version: '0.1.6', commit: 'a'.repeat(40), dirty: true, builtAt: null, token: secret };
  const report = createSyncDiagnostic({
    status: secret,
    info: { status: 'blocked', serverPath: secret, localPath: secret, detail: secret, bindingEpoch: secret, checkedAt: secret, sequence: 1 },
    actionFailed: true, connectionFailed: true,
    versions: { client: identity, frontend: { ...identity, version: secret }, server: identity },
  });
  expect(report).not.toContain(secret);
  expect(JSON.parse(report)).toMatchObject({ checkedAt: null, syncStatus: 'unknown', errorCategories: ['state-read-failed', 'manual-action-incomplete'], components: { client: { dirty: true }, frontend: { version: null } } });
});
