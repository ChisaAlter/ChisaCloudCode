import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(root, 'vendor', 'builtin-plugins');
const outputRoot = path.join(root, 'public', 'builtin-plugins');

// Each shipped plugin is pinned in UPSTREAM.json. There are no runtime clones,
// package installs or CDN imports; the host's existing ws/node-pty remain external.
for (const entry of await fs.readdir(sourceRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const source = path.join(sourceRoot, entry.name);
  const output = path.join(outputRoot, entry.name);
  const manifest = JSON.parse(await fs.readFile(path.join(source, 'manifest.json'), 'utf8'));
  const githubBoard = entry.name === 'claude-github-issue';
  const frontend = path.join(source, 'src', githubBoard ? 'frontend/index.tsx' : entry.name === 'session-manager' ? 'index.js' : 'index.ts');
  const backend = path.join(source, 'src', githubBoard ? 'backend/server.ts' : entry.name === 'session-manager' ? 'server.js' : 'server.ts');
  await fs.mkdir(path.join(output, 'dist'), { recursive: true });
  const inlineStyles = {
    name: 'inline-plugin-styles',
    setup(builder) {
      builder.onResolve({ filter: /\.css\?inline$/ }, (args) => ({
        path: path.resolve(args.resolveDir, args.path.replace(/\?inline$/, '')),
        namespace: 'plugin-css',
      }));
      builder.onLoad({ filter: /.*/, namespace: 'plugin-css' }, async (args) => ({
        contents: await fs.readFile(args.path, 'utf8'), loader: 'text',
      }));
    },
  };
  await build({
    entryPoints: [frontend], outfile: path.join(output, 'dist', 'index.js'),
    bundle: true, platform: 'browser', format: 'esm', target: 'es2020',
    loader: { '.css': 'text' }, plugins: [inlineStyles],
    jsx: 'transform', minify: true, legalComments: 'eof',
  });
  const serverFile = githubBoard ? 'server.cjs' : 'server.js';
  await build({
    entryPoints: [backend], outfile: path.join(output, 'dist', serverFile),
    bundle: true, platform: 'node', format: githubBoard ? 'cjs' : 'esm', target: 'node18',
    external: ['node-pty', 'ws', 'cross-spawn'], legalComments: 'eof',
  });
  await fs.writeFile(path.join(output, 'manifest.json'), `${JSON.stringify({
    ...manifest, entry: 'dist/index.js', server: `dist/${serverFile}`,
    description: manifest.description?.replace(/\bCloudCLI\b/g, 'ChisaCloudCode'),
    bundled: true, defaultEnabled: entry.name === 'claude-usage',
  }, null, 2)}\n`);
  // The package boundary and provenance travel with the executable resources.
  await fs.copyFile(path.join(source, 'package.json'), path.join(output, 'package.json'));
  for (const asset of await fs.readdir(source)) {
    if (/^(?:UPSTREAM\.json|LICEN[CS]E.*|icon\..*)$/i.test(asset)) {
      await fs.copyFile(path.join(source, asset), path.join(output, asset));
    }
  }
  if (githubBoard) await fs.cp(path.join(source, 'skill'), path.join(output, 'skill'), { recursive: true });
  console.log(`[Plugins] Bundled ${manifest.name}`);
}
