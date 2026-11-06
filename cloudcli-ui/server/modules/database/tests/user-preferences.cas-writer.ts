import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';

import { closeConnection, getConnection, userPreferencesDb } from '@/modules/database/index.js';
import type { UserPreferenceTransaction } from '@/shared/index.js';

// Separate-process SQLite writer used only by the CAS integration test's real race.
const [gatePath, resultPath, input] = process.argv.slice(2);
if (!gatePath || !resultPath || !input) throw new Error('CAS writer arguments are required');
const deadline = Date.now() + 10_000;
while (!existsSync(gatePath)) {
  if (Date.now() > deadline) throw new Error('CAS writer barrier timed out');
  await setTimeout(10);
}
try {
  getConnection().pragma('foreign_keys = ON');
  const result = userPreferencesDb.savePreferenceTransaction(1, JSON.parse(input) as UserPreferenceTransaction);
  await writeFile(resultPath, JSON.stringify(result));
} finally {
  closeConnection();
}
