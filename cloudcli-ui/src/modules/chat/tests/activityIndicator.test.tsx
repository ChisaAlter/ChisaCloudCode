import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import ActivityIndicator from '@/modules/chat/composer/ActivityIndicator';
import { i18n } from '@/modules/i18n';
import type { SessionActivity } from '@/shared/types';

const NOW = new Date('2026-10-14T07:00:00Z').getTime();
const TURN_STARTED_AT = NOW - (68 * 60 + 18) * 1000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

test.each([
  ['zh-CN', '正在收尾并交还工作区', '本轮用时 68 分 18 秒'],
  ['en', 'Finalizing and handing back the workspace', 'Total turn time 68m 18s'],
  ['fr', 'Finalizing and handing back the workspace', 'Total turn time 68m 18s'],
])('identifies the elapsed duration as the whole turn during finalization in %s', async (language, label, elapsed) => {
  const translations = i18n.cloneInstance({ lng: language });
  await translations.changeLanguage(language);

  render(<I18nextProvider i18n={translations}>
    <ActivityIndicator activity={{ statusText: 'workspace_finalizing', canInterrupt: false, startedAt: TURN_STARTED_AT }} onAbort={vi.fn()} />
  </I18nextProvider>);

  expect(screen.getByText(label)).toBeDefined();
  expect(screen.getByText(elapsed)).toBeDefined();
  expect(screen.queryByRole('button')).toBeNull();
});

test('keeps the existing whole-turn clock and ordinary activity display when finalization begins', async () => {
  const translations = i18n.cloneInstance({ lng: 'zh-CN' });
  await translations.changeLanguage('zh-CN');
  const activity: SessionActivity = { statusText: '正在处理', canInterrupt: true, startedAt: TURN_STARTED_AT };
  const onAbort = vi.fn();
  const content = (current: SessionActivity) => <I18nextProvider i18n={translations}>
    <ActivityIndicator activity={current} onAbort={onAbort} />
  </I18nextProvider>;
  const view = render(content(activity));

  expect(screen.getByText('正在处理')).toBeDefined();
  expect(screen.getByText('68 分 18 秒')).toBeDefined();
  expect(screen.queryByText(/本轮用时/)).toBeNull();
  expect(screen.getByRole('button', { name: '停止生成' })).toBeDefined();

  view.rerender(content({ ...activity, statusText: 'workspace_finalizing', canInterrupt: false }));
  act(() => { vi.advanceTimersByTime(1000); });

  expect(screen.getByText('正在收尾并交还工作区')).toBeDefined();
  expect(screen.getByText('本轮用时 68 分 19 秒')).toBeDefined();
  expect(screen.queryByRole('button')).toBeNull();
});

test.each([
  ['zh-CN', '已停止，正在交还工作区', '本轮用时 68 分 18 秒'],
  ['en', 'Stopped; handing back the workspace', 'Total turn time 68m 18s'],
])('identifies confirmed stop separately from file handback in %s', async (language, label, elapsed) => {
  const translations = i18n.cloneInstance({ lng: language });
  await translations.changeLanguage(language);
  render(<I18nextProvider i18n={translations}>
    <ActivityIndicator activity={{
      runId: 'stopped-run', statusText: 'workspace_finalizing', modelStopped: true, canInterrupt: false, startedAt: TURN_STARTED_AT,
    }} onAbort={vi.fn()} />
  </I18nextProvider>);
  expect(screen.getByText(label)).toBeDefined();
  expect(screen.getByText(elapsed)).toBeDefined();
  expect(screen.queryByRole('button')).toBeNull();
});
