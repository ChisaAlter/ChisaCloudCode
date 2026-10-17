import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react({ jsxRuntime: 'classic' })],
  define: {
    'process.env': '{}',
    'process.env.NODE_ENV': '"production"',
  },
  build: {
    lib: {
      entry: path.resolve(__dirname, 'src/frontend/index.tsx'),
      name: 'ClaudeGithubIssuePlugin',
      // ESM format: plugin host uses dynamic import() on a Blob URL
      formats: ['es'],
      fileName: () => 'frontend.js',
    },
    outDir: 'dist',
    emptyOutDir: false,
    rollupOptions: {
      // Bundle everything including React — plugin host may not provide it
      external: [],
      output: {
        inlineDynamicImports: true,
      },
    },
    // Inline CSS into JS so we only ship one file
    cssCodeSplit: false,
    minify: false,
    sourcemap: false,
  },
});
