import type { ErrorInfo, ReactNode } from 'react';
import { ErrorBoundary, type FallbackProps } from 'react-error-boundary';

import { i18n } from '@/modules/i18n';
import { reportFrontendError } from '@/shared/chisa';

function ApplicationErrorFallback({ error }: FallbackProps) {
  return (
    <main role="alert" className="fixed inset-0 flex items-center justify-center bg-background p-8 text-foreground">
      <section className="w-full max-w-lg rounded-xl border border-border bg-card p-6 shadow-sm">
        <h1 className="text-lg font-semibold">{i18n.t('misc.appErrorTitle', { ns: 'common' })}</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">{i18n.t('misc.appErrorDescription', { ns: 'common' })}</p>
        <details className="mt-4 text-sm">
          <summary className="cursor-pointer">{i18n.t('misc.errorDetails', { ns: 'common' })}</summary>
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-3 text-xs">{error instanceof Error ? error.message : String(error)}</pre>
        </details>
        <button type="button" onClick={() => window.location.reload()} className="mt-5 rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground">
          {i18n.t('misc.reloadInterface', { ns: 'common' })}
        </button>
      </section>
    </main>
  );
}

function handleApplicationError(error: Error, info: ErrorInfo): void {
  console.error('Application render failed:', error, info);
  reportFrontendError('app-render', error, info.componentStack ?? '');
}

/** main.tsx wraps App and all providers so a workspace or sidebar failure cannot leave an empty window. */
export function ApplicationErrorBoundary({ children }: { children: ReactNode }) {
  return <ErrorBoundary FallbackComponent={ApplicationErrorFallback} onError={handleApplicationError}>{children}</ErrorBoundary>;
}
