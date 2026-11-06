import path from 'node:path';
import ts from 'typescript';

const files = [
  'server/modules/database/repositories/user-preferences.db.ts',
  'server/modules/database/tests/user-preferences.cas-writer.ts',
  'server/modules/database/tests/user-preferences.cas.integration.test.ts',
  'server/modules/user/user.service.ts',
  'server/modules/user/user.routes.ts',
  'server/modules/user/user.module.ts',
  'server/modules/user/tests/user.service.test.ts',
  'server/modules/user/tests/user.routes.test.ts',
  'server/modules/user/tests/user.preferences-cas.routes.integration.test.ts',
];
const configPath = path.resolve('server/tsconfig.json');
const config = ts.readConfigFile(configPath, ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
const program = ts.createProgram(files, { ...parsed.options, noEmit: true });
const diagnostics = ts.getPreEmitDiagnostics(program);
const owned = new Set(files.map((file) => path.resolve(file).toLowerCase()));
const local = diagnostics.filter((item) => !item.file || owned.has(path.resolve(item.file.fileName).toLowerCase()));
const upstream = diagnostics.length - local.length;
const host = { getCanonicalFileName: (name) => name, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n' };
console.log(`Scoped no-emit semantic check: ${files.length} W07 files; ${local.length} owned diagnostics; ${upstream} other imported-file diagnostics (not modified here).`);
if (local.length) console.log(ts.formatDiagnostics(local, host));
process.exitCode = local.length ? 1 : 0;
