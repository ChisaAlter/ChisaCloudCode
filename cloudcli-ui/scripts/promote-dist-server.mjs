#!/usr/bin/env node
// The server build stages into dist-server.next and this script promotes it
// into place. The live dist-server must never be deleted before the new build
// is complete: an interrupted build would otherwise leave the installation
// without a server entrypoint, crash-looping on MODULE_NOT_FOUND at every
// start until someone rebuilds it by hand.
import fs from 'node:fs';

const NEXT = 'dist-server.next';
const LIVE = 'dist-server';
const OLD = 'dist-server.old';
const ENTRY = 'server/index.js';

const mode = process.argv[2] ?? 'promote';

if (mode === 'recover') {
  // Ran before every server start: if a promotion was interrupted between the
  // two renames, put the previous build back so the server can boot.
  if (!fs.existsSync(`${LIVE}/${ENTRY}`) && fs.existsSync(`${OLD}/${ENTRY}`)) {
    console.error('promote-dist-server: restoring previous dist-server after an interrupted promotion.');
    fs.rmSync(LIVE, { recursive: true, force: true });
    fs.renameSync(OLD, LIVE);
  }
  process.exit(0);
}

if (mode !== 'promote') {
  console.error(`promote-dist-server: unknown mode "${mode}" (expected "promote" or "recover").`);
  process.exit(64);
}

// TypeScript resolves a shared .js/.d.ts pair through the declaration and can
// omit the JavaScript runtime file. Preserve such source modules in staging so
// a successful typecheck cannot publish an image with missing shared imports.
function copyMissingSharedRuntime(directory = 'shared', relative = '') {
  if (!fs.existsSync(directory)) return;
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const source = `${directory}/${item.name}`;
    const suffix = relative ? `${relative}/${item.name}` : item.name;
    if (item.isDirectory()) copyMissingSharedRuntime(source, suffix);
    else if (item.isFile() && item.name.endsWith('.js')) {
      const target = `${NEXT}/shared/${suffix}`;
      if (!fs.existsSync(target)) {
        fs.mkdirSync(target.slice(0, target.lastIndexOf('/')), { recursive: true });
        fs.copyFileSync(source, target);
      }
    }
  }
}
copyMissingSharedRuntime();

if (!fs.existsSync(`${NEXT}/${ENTRY}`)) {
  console.error(`promote-dist-server: ${NEXT}/${ENTRY} is missing; leaving the current ${LIVE} untouched.`);
  process.exit(1);
}

fs.rmSync(OLD, { recursive: true, force: true });
if (fs.existsSync(LIVE)) {
  fs.renameSync(LIVE, OLD);
}
try {
  fs.renameSync(NEXT, LIVE);
} catch (error) {
  // Put the previous build back before failing so the installation still boots.
  if (fs.existsSync(OLD) && !fs.existsSync(LIVE)) {
    fs.renameSync(OLD, LIVE);
  }
  throw error;
}
fs.rmSync(OLD, { recursive: true, force: true });
