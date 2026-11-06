import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const directory = 'docs/remediation/2026-10-31/W07-preference-cas';
for (const name of fs.readdirSync(directory).filter((name) => name.endsWith('.log'))) {
  const file = path.join(directory, name);
  const bytes = fs.readFileSync(file);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) fs.writeFileSync(file, bytes.subarray(2).toString('utf16le'), 'utf8');
}
const files = [
  'server/modules/database/repositories/user-preferences.db.ts',
  'server/modules/database/tests/user-preferences.cas-writer.ts',
  'server/modules/database/tests/user-preferences.cas.integration.test.ts',
  'server/modules/database/tests/user-preferences.db.integration.test.ts',
  'server/modules/user/user.service.ts',
  'server/modules/user/user.routes.ts',
  'server/modules/user/user.module.ts',
  'server/modules/user/tests/user.service.test.ts',
  'server/modules/user/tests/user.routes.test.ts',
  'server/modules/user/tests/user.preferences-cas.routes.integration.test.ts',
  'server/modules/database/schema.ts',
  'server/modules/database/migrations.ts',
  'server/shared/types.ts',
  'server/shared/index.ts',
  `${directory}/contract.md`,
  `${directory}/tests-final.log`,
  `${directory}/typecheck-final.log`,
  `${directory}/lint-final.log`,
  `${directory}/typecheck.mjs`,
];
const hashes = files.map((file) => `${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}  ${file}`).join('\n') + '\n';
fs.writeFileSync(path.join(directory, 'sha256.txt'), hashes, 'utf8');
console.log(`Normalized generated logs and recorded SHA-256 for ${files.length} final evidence/source files.`);
