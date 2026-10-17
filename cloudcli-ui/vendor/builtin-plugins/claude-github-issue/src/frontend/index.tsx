import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PluginProvider } from './PluginContext';
import { App } from './App';
import type { PluginAPI } from './types';
// Import CSS as a raw string using Vite's ?inline query — no separate .css file emitted
import stylesRaw from './styles.css?inline';

// Inject plugin styles into document head (once only, idempotent)
const STYLE_ID = 'cgi-plugin-styles';
if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
  const styleEl = document.createElement('style');
  styleEl.id = STYLE_ID;
  styleEl.textContent = stylesRaw;
  document.head.appendChild(styleEl);
}

// Keep track of React roots by container element
const roots = new WeakMap<HTMLElement, Root>();

export function mount(container: HTMLElement, api: PluginAPI): void {
  let root = roots.get(container);
  if (!root) {
    root = createRoot(container);
    roots.set(container, root);
  }
  root.render(
    <React.StrictMode>
      <PluginProvider api={api}>
        <App />
      </PluginProvider>
    </React.StrictMode>
  );
}

export function unmount(container: HTMLElement): void {
  const root = roots.get(container);
  if (root) {
    root.unmount();
    roots.delete(container);
  }
}
