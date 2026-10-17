import { useEffect } from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import { ApplicationErrorBoundary } from '@/modules/desktop-chrome/ApplicationErrorBoundary';

const diagnostics = vi.hoisted(() => ({ report: vi.fn() }));
vi.mock('@/shared/chisa', () => ({ reportFrontendError: diagnostics.report }));
vi.mock('@/modules/i18n', () => ({ i18n: { t: (key: string) => key } }));

beforeEach(() => {
  diagnostics.report.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

test.each(['render', 'effect'] as const)('replaces a root %s failure with a visible fallback and component diagnostics', (phase) => {
  const failure = new Error(`${phase} failed`);
  function BrokenWorkspace() {
    useEffect(() => {
      if (phase === 'effect') throw failure;
    }, []);
    if (phase === 'render') throw failure;
    return <div>Workspace</div>;
  }

  render(<ApplicationErrorBoundary><BrokenWorkspace /></ApplicationErrorBoundary>);

  expect(screen.getByRole('alert').textContent).toContain('misc.appErrorDescription');
  expect(screen.getByRole('heading', { name: 'misc.appErrorTitle' })).toBeDefined();
  expect(screen.getByRole('button', { name: 'misc.reloadInterface' })).toBeDefined();
  expect(screen.getByText(failure.message)).toBeDefined();
  expect(screen.queryByText('Workspace')).toBeNull();
  expect(diagnostics.report).toHaveBeenCalledTimes(1);
  expect(diagnostics.report).toHaveBeenCalledWith('app-render', failure, expect.stringContaining('BrokenWorkspace'));
});

test('keeps the failed workspace unmounted across parent updates instead of restarting its send effect', () => {
  const submitMessage = vi.fn();
  const cleanupWorkspace = vi.fn();
  const failure = new Error('sidebar failed');
  function Workspace({ crash }: { crash: boolean }) {
    useEffect(() => {
      submitMessage();
      return cleanupWorkspace;
    }, []);
    if (crash) throw failure;
    return <div>Current session</div>;
  }
  const view = render(<ApplicationErrorBoundary><Workspace crash={false} /></ApplicationErrorBoundary>);
  expect(submitMessage).toHaveBeenCalledTimes(1);

  view.rerender(<ApplicationErrorBoundary><Workspace crash /></ApplicationErrorBoundary>);
  expect(screen.getByRole('alert')).toBeDefined();
  expect(cleanupWorkspace).toHaveBeenCalledTimes(1);

  view.rerender(<ApplicationErrorBoundary><Workspace crash={false} /></ApplicationErrorBoundary>);
  expect(screen.getByRole('alert')).toBeDefined();
  expect(screen.queryByText('Current session')).toBeNull();
  expect(submitMessage).toHaveBeenCalledTimes(1);
  expect(diagnostics.report).toHaveBeenCalledTimes(1);
});
