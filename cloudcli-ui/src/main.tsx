import React from 'react'
import ReactDOM from 'react-dom/client'

import App from '@/App'
import { ApplicationErrorBoundary } from '@/modules/desktop-chrome'
import { installFrontendErrorReporting } from '@/shared/chisa'
import '@/index.css'
import 'katex/dist/katex.min.css'

// Initialize i18n
import '@/modules/i18n'

installFrontendErrorReporting()

// React Scan is a render-diagnostics overlay, and an expensive one: measured on
// this app it roughly halves the dev frame rate, adds ~14 MB of heap and injects
// a few thousand DOM nodes of its own. It is worth all of that while hunting a
// render bug and worth none of it the rest of the time, so it is opt-in —
// `localStorage.setItem('react-scan', 'on')` and reload.
if (import.meta.env.DEV) {
  // Keep the optional diagnostic dependency out of production and avoid loading
  // it until explicitly enabled; storage restrictions must not block startup.
  try {
    if (localStorage.getItem('react-scan') === 'on') {
      void import('react-scan').then(({ scan }) => scan({ enabled: true })).catch(error => {
        console.warn('Unable to load render diagnostics:', error);
      });
    }
  } catch { /* Restricted storage disables this opt-in development overlay. */ }
}

// Register service worker for PWA + Web Push support
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(err => {
    console.warn('Service worker registration failed:', err);
  });
}

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('Unable to mount the app: #root is missing from the document')
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <ApplicationErrorBoundary>
      <App />
    </ApplicationErrorBoundary>
  </React.StrictMode>,
)
