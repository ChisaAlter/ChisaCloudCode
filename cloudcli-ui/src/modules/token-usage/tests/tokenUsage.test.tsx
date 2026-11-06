import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import { TokenUsageButton, TokenUsageDialog } from '@/modules/token-usage';
import type * as ApiModule from '@/shared/api';
import type * as AuthTokenModule from '@/shared/authToken';
import type * as ChisaModule from '@/shared/chisa';
import type { TokenStatisticsCounts, TokenStatisticsRange, TokenStatisticsReport } from '@/shared/types';

const runtime = vi.hoisted(() => ({
  tokenStatistics: vi.fn(),
  auth: 0,
  server: 0,
}));

// Keep the shared envelope reader real so malformed/error responses exercise the production path.
vi.mock('@/shared/api', async original => ({
  ...await original<typeof ApiModule>(),
  api: { providers: { tokenStatistics: runtime.tokenStatistics }, user: { savePreferences: vi.fn(async () => response({ success: true })) } },
}));
vi.mock('@/shared/authToken', async original => ({
  ...await original<typeof AuthTokenModule>(),
  getAuthSessionVersion: () => runtime.auth,
}));
vi.mock('@/shared/chisa', async original => ({
  ...await original<typeof ChisaModule>(),
  getServerConnectionVersion: () => runtime.server,
}));

const COUNTS: TokenStatisticsCounts = {
  inputTokens: 1_234,
  outputTokens: 432,
  cacheReadTokens: 9_876,
  cacheCreationTokens: 321,
  totalTokens: 11_863,
  requests: 7,
};
const ZERO: TokenStatisticsCounts = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0, requests: 0 };

function report(range: TokenStatisticsRange = '7d', sessionId: string | null = null, overrides: Partial<TokenStatisticsReport> = {}): TokenStatisticsReport {
  return {
    range,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    sessionId,
    generatedAt: '2026-10-29T00:00:00.000Z',
    totals: { ...COUNTS, sessions: 1 },
    daily: [{ ...COUNTS, date: '2026-10-29' }],
    byModel: [{ ...COUNTS, provider: 'claude', model: 'recorded-model' }],
    bySession: [{ ...COUNTS, sessionId: sessionId || 'saved-session', title: 'Archived record', projectName: 'Workspace', provider: 'claude', isArchived: true }],
    coverage: { indexedSessions: 1, measuredSessions: 1, unavailableSessions: 0, unsupportedSessions: 0 },
    ...overrides,
  };
}

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

function ok(value: TokenStatisticsReport) {
  return response({ success: true, data: value });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(fulfill => { resolve = fulfill; });
  return { promise, resolve };
}

beforeEach(async () => {
  runtime.auth = 0;
  runtime.server = 0;
  runtime.tokenStatistics.mockReset();
  runtime.tokenStatistics.mockImplementation(async (filters: { range: TokenStatisticsRange; sessionId?: string }) => ok(report(filters.range, filters.sessionId ?? null)));
  await i18n.changeLanguage('en');
});

describe('token usage entry', () => {
  it('owns a compact dialog and fetches only after opening, resetting defaults after close', async () => {
    render(<TokenUsageButton sessionId="session-one" sessionTitle="Active conversation" className="custom-trigger" />);
    expect(runtime.tokenStatistics).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    const trigger = screen.getByRole('button', { name: 'Token usage' });
    expect(trigger.textContent).toBe('Token');
    expect(trigger.className).toContain('custom-trigger');
    fireEvent.click(trigger);
    await waitFor(() => expect(screen.getByTestId('token-statistics-total').textContent).toBe('11,863'));
    expect(screen.getByRole('dialog', { name: 'Token usage' })).toBeTruthy();
    expect(runtime.tokenStatistics).toHaveBeenLastCalledWith(
      { range: 'all', timeZone: expect.any(String), sessionId: 'session-one' },
      { signal: expect.any(AbortSignal) },
    );
    expect(screen.getByText('Active conversation')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '30 days' }));
    await waitFor(() => expect(runtime.tokenStatistics).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'Close token usage' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(trigger);
    await waitFor(() => expect(runtime.tokenStatistics).toHaveBeenCalledTimes(3));
    expect(runtime.tokenStatistics.mock.calls[2][0].range).toBe('all');
  });

  it('delegates a click without creating or fetching its own dialog', () => {
    const onClick = vi.fn();
    render(<TokenUsageButton sessionId="session-one" onClick={onClick} />);
    fireEvent.click(screen.getByRole('button', { name: 'Token usage' }));
    expect(onClick).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(runtime.tokenStatistics).not.toHaveBeenCalled();
  });

  it('discards an owned open dialog after an account change, including when closed', async () => {
    const view = render(<TokenUsageButton sessionId="session-one" />);
    fireEvent.click(screen.getByRole('button', { name: 'Token usage' }));
    await waitFor(() => expect(screen.getByTestId('token-statistics-total').textContent).toBe('11,863'));
    runtime.auth += 1;
    view.rerender(<TokenUsageButton sessionId="session-one" />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(runtime.tokenStatistics).toHaveBeenCalledOnce();
    runtime.server += 1;
    view.rerender(<TokenUsageButton sessionId="session-one" />);
    fireEvent.click(screen.getByRole('button', { name: 'Token usage' }));
    await waitFor(() => expect(runtime.tokenStatistics).toHaveBeenCalledTimes(2));
    expect(runtime.tokenStatistics.mock.calls[1][0].range).toBe('all');
  });
});

describe('saved token statistics', () => {
  it('starts account statistics at seven calendar dates and shows the four disjoint counters', async () => {
    render(<TokenUsageDialog open onOpenChange={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('token-statistics-total').textContent).toBe('11,863'));
    expect(runtime.tokenStatistics).toHaveBeenLastCalledWith(
      { range: '7d', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      { signal: expect.any(AbortSignal) },
    );
    expect(screen.queryByRole('button', { name: 'Current conversation' })).toBeNull();
    expect(screen.getByRole('button', { name: '7 days' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('token-statistics-input').textContent).toBe('1,234');
    expect(screen.getByTestId('token-statistics-output').textContent).toBe('432');
    expect(screen.getByTestId('token-statistics-cacheRead').textContent).toBe('9,876');
    expect(screen.getByTestId('token-statistics-cacheCreation').textContent).toBe('321');
    expect(screen.getByText('7 requests · 1 conversation')).toBeTruthy();
    expect(screen.getByText(/Time zone:/)).toBeTruthy();
    expect(screen.queryByText(/\$|cost|price/i)).toBeNull();
  });

  it('switches scope defaults, supports every range and clears the previous total while loading', async () => {
    render(<TokenUsageDialog open onOpenChange={() => {}} sessionId="session-one" />);
    await waitFor(() => expect(screen.getByTestId('token-statistics-total').textContent).toBe('11,863'));
    const pending = deferred<Response>();
    runtime.tokenStatistics.mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole('button', { name: 'All conversations' }));
    expect(screen.getByTestId('token-statistics-total').textContent).toBe('—');
    expect(screen.getByRole('status').textContent).toContain('Loading');
    expect(runtime.tokenStatistics.mock.calls[1][0]).toEqual({ range: '7d', timeZone: expect.any(String) });
    await act(async () => pending.resolve(ok(report('7d'))));
    for (const [label, range] of [['Today', 'today'], ['30 days', '30d'], ['All time', 'all']] as const) {
      fireEvent.click(screen.getByRole('button', { name: label }));
      await waitFor(() => expect(screen.getByTestId('token-statistics-total').textContent).toBe('11,863'));
      expect(runtime.tokenStatistics.mock.lastCall?.[0].range).toBe(range);
    }
    fireEvent.click(screen.getByRole('button', { name: 'Current conversation' }));
    await waitFor(() => expect(runtime.tokenStatistics.mock.lastCall?.[0]).toEqual({ range: 'all', timeZone: expect.any(String), sessionId: 'session-one' }));
  });

  it('refreshes the selected query and keeps breakdowns closed, scrollable and complete', async () => {
    const daily = Array.from({ length: 45 }, (_, index) => ({ ...COUNTS, date: `2026-row-${index}` }));
    runtime.tokenStatistics.mockResolvedValueOnce(ok(report('7d', null, { daily })));
    render(<TokenUsageDialog open onOpenChange={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('token-statistics-total').textContent).toBe('11,863'));
    expect(screen.getByText('By day', { selector: 'summary' }).closest('details')?.open).toBe(false);
    expect(screen.getByText('By model', { selector: 'summary' }).closest('details')?.open).toBe(false);
    expect(screen.getByText('By conversation', { selector: 'summary' }).closest('details')?.open).toBe(false);
    fireEvent.click(screen.getByText('By day', { selector: 'summary' }));
    const table = screen.getByRole('table', { name: 'By day' });
    expect(within(table).getAllByRole('row')).toHaveLength(46);
    expect(within(table).getByText('2026-row-44')).toBeTruthy();
    expect(table.parentElement?.className).toContain('overflow-auto');
    fireEvent.click(screen.getByText('By conversation', { selector: 'summary' }));
    expect(screen.getByText('Archived')).toBeTruthy();
    expect(screen.getByText('Archived record')).toBeTruthy();
    fireEvent.click(screen.getByText('Coverage and counting'));
    expect(screen.getByText(/cumulative usage, not context occupancy/)).toBeTruthy();
    expect(screen.getByText(/including archived conversations/)).toBeTruthy();
    expect(screen.getByText(/Updated /)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(screen.getByTestId('token-statistics-total').textContent).toBe('—');
    await waitFor(() => expect(runtime.tokenStatistics).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('token-statistics-total').textContent).toBe('11,863'));
    expect(runtime.tokenStatistics.mock.calls[1][0]).toEqual(runtime.tokenStatistics.mock.calls[0][0]);
  });

  it('shows an empty report without presenting unknown consumption as zero', async () => {
    runtime.tokenStatistics.mockResolvedValueOnce(ok(report('7d', null, {
      totals: { ...ZERO, sessions: 0 }, daily: [], byModel: [], bySession: [],
      coverage: { indexedSessions: 0, measuredSessions: 0, unavailableSessions: 0, unsupportedSessions: 0 },
    })));
    render(<TokenUsageDialog open onOpenChange={() => {}} />);
    await screen.findByText('No saved conversations were found for this selection.');
    expect(screen.getByTestId('token-statistics-total').textContent).toBe('—');
    expect(screen.getByText('Usage recorded for 0 of 0 saved conversations')).toBeTruthy();
    fireEvent.click(screen.getByText('By day', { selector: 'summary' }));
    expect(screen.queryByRole('table', { name: 'By day' })).toBeNull();
    expect(screen.getAllByText('No recorded usage for this breakdown.')).toHaveLength(3);
    expect(screen.queryByText(/Recorded usage is zero/)).toBeNull();
  });

  it('separates unsupported and missing coverage from measured zero usage', async () => {
    runtime.tokenStatistics.mockResolvedValueOnce(ok(report('7d', null, {
      totals: { ...ZERO, sessions: 0 }, daily: [], byModel: [], bySession: [],
      coverage: { indexedSessions: 3, measuredSessions: 0, unavailableSessions: 2, unsupportedSessions: 1 },
    })));
    render(<TokenUsageDialog open onOpenChange={() => {}} />);
    await screen.findByText(/Missing usage is unknown, not zero/);
    expect(screen.getByText('No usage recorded: 2 · Unsupported: 1')).toBeTruthy();
    expect(screen.getByTestId('token-statistics-total').textContent).toBe('—');
    runtime.tokenStatistics.mockResolvedValueOnce(ok(report('7d', null, {
      totals: { ...ZERO, sessions: 1 }, daily: [], byModel: [], bySession: [],
      coverage: { indexedSessions: 3, measuredSessions: 1, unavailableSessions: 1, unsupportedSessions: 1 },
    })));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByText('Recorded usage is zero for this date range.');
    expect(screen.getByTestId('token-statistics-total').textContent).toBe('0');
    expect(screen.getByText('Usage recorded for 1 of 3 saved conversations')).toBeTruthy();
    expect(screen.getByText('No usage recorded: 1 · Unsupported: 1')).toBeTruthy();
  });

  it('shows real error envelopes and retries without retaining an old report', async () => {
    runtime.tokenStatistics.mockResolvedValueOnce(response({ success: false, error: { code: 'TEMPORARY', message: 'Statistics unavailable' } }, 503));
    render(<TokenUsageDialog open onOpenChange={() => {}} />);
    await screen.findByRole('alert');
    expect(screen.getByText('Statistics unavailable')).toBeTruthy();
    expect(screen.getByTestId('token-statistics-total').textContent).toBe('—');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByTestId('token-statistics-total').textContent).toBe('11,863'));
    runtime.tokenStatistics.mockRejectedValueOnce(new Error('Refresh failed'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByText('Refresh failed');
    expect(screen.getByTestId('token-statistics-total').textContent).toBe('—');
    expect(screen.queryByText('Usage recorded for 1 of 1 saved conversations')).toBeNull();
  });

  it('names a server that predates the statistics route instead of reporting a read failure', async () => {
    // An older server answers an unknown /api path with its SPA shell: 200 plus HTML, never JSON.
    runtime.tokenStatistics.mockResolvedValueOnce(new Response('<!doctype html><html></html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
    render(<TokenUsageDialog open onOpenChange={() => {}} />);
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/connected server does not offer saved token usage/)).toBeTruthy();
    expect(within(alert).queryByText('Unable to load token usage. Please retry.')).toBeNull();
    expect(within(alert).getByText('Invalid JSON response (200)')).toBeTruthy();
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.getByTestId('token-statistics-total').textContent).toBe('—');
  });

  it('keeps the neutral read failure when the server reports a temporary error', async () => {
    runtime.tokenStatistics.mockResolvedValueOnce(response({ success: false, error: { code: 'TEMPORARY', message: 'Statistics unavailable' } }, 503));
    render(<TokenUsageDialog open onOpenChange={() => {}} />);
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Unable to load token usage. Please retry.')).toBeTruthy();
    expect(within(alert).queryByText(/connected server does not offer saved token usage/)).toBeNull();
  });

  it.each([
    { success: true },
    { success: true, data: null },
    { success: true, data: { totals: { totalTokens: 42 } } },
  ])('rejects an incomplete successful response instead of inventing zeroes', async payload => {
    runtime.tokenStatistics.mockResolvedValueOnce(response(payload));
    render(<TokenUsageDialog open onOpenChange={() => {}} />);
    await screen.findByRole('alert');
    expect(screen.getByTestId('token-statistics-total').textContent).toBe('—');
    expect(screen.queryByText(/No saved conversations|Recorded usage is zero/)).toBeNull();
  });

  it('rejects a complete response for another scope', async () => {
    runtime.tokenStatistics.mockResolvedValueOnce(ok(report('7d', 'another-session')));
    render(<TokenUsageDialog open onOpenChange={() => {}} />);
    await screen.findByRole('alert');
    expect(screen.getByTestId('token-statistics-total').textContent).toBe('—');
  });

  it('aborts replaced filters and ignores a deferred response even when transport ignores abort', async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    runtime.tokenStatistics.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(<TokenUsageDialog open onOpenChange={() => {}} sessionId="session-one" />);
    const firstSignal = runtime.tokenStatistics.mock.calls[0][1].signal as AbortSignal;
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    expect(firstSignal.aborted).toBe(true);
    await act(async () => second.resolve(ok(report('today', 'session-one', { totals: { ...COUNTS, totalTokens: 777, sessions: 1 } }))));
    expect(screen.getByTestId('token-statistics-total').textContent).toBe('777');
    await act(async () => first.resolve(ok(report('all', 'session-one'))));
    expect(screen.getByTestId('token-statistics-total').textContent).toBe('777');
  });

  it('keeps a returned filter pending until its new request completes', async () => {
    render(<TokenUsageDialog open onOpenChange={() => {}} sessionId="session-one" />);
    await waitFor(() => expect(screen.getByTestId('token-statistics-total').textContent).toBe('11,863'));
    const otherRange = deferred<Response>();
    const returnedRange = deferred<Response>();
    runtime.tokenStatistics.mockReturnValueOnce(otherRange.promise).mockReturnValueOnce(returnedRange.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    fireEvent.click(screen.getByRole('button', { name: 'All time' }));
    expect(screen.getByTestId('token-statistics-total').textContent).toBe('—');
    await act(async () => otherRange.resolve(ok(report('today', 'session-one'))));
    expect(screen.getByTestId('token-statistics-total').textContent).toBe('—');
    await act(async () => returnedRange.resolve(ok(report('all', 'session-one'))));
    expect(screen.getByTestId('token-statistics-total').textContent).toBe('11,863');
  });

  it.each(['auth', 'server'] as const)('clears completed data and prevents deferred %s identity replies from reaching a new owner', async identity => {
    const view = render(<TokenUsageDialog open onOpenChange={() => {}} sessionId="session-one" />);
    await waitFor(() => expect(screen.getByTestId('token-statistics-total').textContent).toBe('11,863'));
    const stale = deferred<Response>();
    runtime.tokenStatistics.mockReturnValueOnce(stale.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    const staleSignal = runtime.tokenStatistics.mock.calls[1][1].signal as AbortSignal;
    const current = deferred<Response>();
    runtime.tokenStatistics.mockReturnValueOnce(current.promise);
    runtime[identity] += 1;
    view.rerender(<TokenUsageDialog open onOpenChange={() => {}} sessionId="session-one" />);
    expect(screen.getByTestId('token-statistics-total').textContent).toBe('—');
    expect(staleSignal.aborted).toBe(true);
    expect(screen.getByRole('button', { name: 'All time' }).getAttribute('aria-pressed')).toBe('true');
    await act(async () => stale.resolve(ok(report('today', 'session-one'))));
    expect(screen.getByTestId('token-statistics-total').textContent).toBe('—');
    await act(async () => current.resolve(ok(report('all', 'session-one', { totals: { ...COUNTS, totalTokens: 888, sessions: 1 } }))));
    expect(screen.getByTestId('token-statistics-total').textContent).toBe('888');
  });

  it('discards a late identity reply before a React rerender', async () => {
    const pending = deferred<Response>();
    runtime.tokenStatistics.mockReturnValueOnce(pending.promise);
    render(<TokenUsageDialog open onOpenChange={() => {}} />);
    runtime.auth += 1;
    await act(async () => pending.resolve(ok(report())));
    expect(screen.getByTestId('token-statistics-total').textContent).toBe('—');
    expect(screen.queryByText('Usage recorded for 1 of 1 saved conversations')).toBeNull();
  });

  it('aborts on close and starts correct defaults when the session changes while closed', async () => {
    const pending = deferred<Response>();
    runtime.tokenStatistics.mockReturnValueOnce(pending.promise);
    const view = render(<TokenUsageDialog open onOpenChange={() => {}} sessionId="old-session" />);
    const signal = runtime.tokenStatistics.mock.calls[0][1].signal as AbortSignal;
    view.rerender(<TokenUsageDialog open={false} onOpenChange={() => {}} sessionId="new-session" />);
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(ok(report('all', 'old-session'))));
    expect(screen.queryByRole('dialog')).toBeNull();
    view.rerender(<TokenUsageDialog open onOpenChange={() => {}} sessionId="new-session" />);
    await waitFor(() => expect(screen.getByTestId('token-statistics-total').textContent).toBe('11,863'));
    expect(runtime.tokenStatistics.mock.lastCall?.[0]).toEqual({ range: 'all', timeZone: expect.any(String), sessionId: 'new-session' });
  });
});
