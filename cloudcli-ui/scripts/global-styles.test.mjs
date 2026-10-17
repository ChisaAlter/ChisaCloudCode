import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import autoprefixer from 'autoprefixer';
import { transform } from 'esbuild';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import loadConfig from 'tailwindcss/loadConfig.js';

test('global touch CSS remains valid when content generates important class variants', async () => {
  const filename = fileURLToPath(new URL('../src/index.css', import.meta.url));
  const config = loadConfig(fileURLToPath(new URL('../tailwind.config.js', import.meta.url)));
  const css = await readFile(filename, 'utf8');
  const result = await postcss([
    tailwindcss({
      ...config,
      // Logical negations in application source are also Tailwind content candidates.
      content: [{ raw: '!user !error !xterm-viewport overflow-y-auto chat-message', extension: 'tsx' }],
    }),
    autoprefixer(),
  ]).process(css, { from: filename });
  const compiled = await transform(result.css, { loader: 'css', minify: true, logLevel: 'silent' });

  assert.deepEqual(compiled.warnings, []);
});
