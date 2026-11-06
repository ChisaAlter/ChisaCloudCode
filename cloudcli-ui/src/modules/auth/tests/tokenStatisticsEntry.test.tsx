import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import { AccountMenu } from '@/modules/auth/AccountMenu';
import { api } from '@/shared/api';
import { i18n } from '@/modules/i18n';

const account = vi.hoisted(() => ({ user: { id: 1, username: 'ayase' } as { id: number; username: string } | null }));
vi.mock('@/modules/auth/context/AuthContext', () => ({ useAuth: () => ({ user: account.user, logout: vi.fn() }) }));
vi.mock('@/modules/auth/AccountPopup', () => ({ AccountPopup: () => null }));
vi.mock('@/modules/auth/AccountAvatar', () => ({ AccountAvatar: () => null }));

beforeEach(async () => { account.user = { id: 1, username: 'ayase' }; vi.restoreAllMocks(); await i18n.changeLanguage('zh-CN'); });

test('the signed-in account menu opens cumulative account statistics without requesting subscription quota', async () => {
  const usage = vi.spyOn(api.providers, 'tokenStatistics').mockResolvedValue(Response.json({ success: true, data: {
    range: '7d', timeZone: 'Asia/Shanghai', sessionId: null, generatedAt: '2026-10-29T02:00:00Z',
    totals: { inputTokens: 20, outputTokens: 10, cacheReadTokens: 50, cacheCreationTokens: 5, totalTokens: 85, requests: 2, sessions: 1 },
    daily: [], byModel: [], bySession: [], coverage: { indexedSessions: 1, measuredSessions: 1, unavailableSessions: 0, unsupportedSessions: 0 },
  } }));
  render(<AccountMenu />);
  expect(usage).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '账户菜单：ayase' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Token 用量统计' }));
  expect(await screen.findByRole('dialog', { name: 'Token 用量' })).toBeTruthy();
  expect(usage).toHaveBeenCalledWith(expect.objectContaining({ range: '7d' }), expect.any(Object));
  expect(usage.mock.calls[0][0].sessionId).toBeFalsy();
});

test('signed-out accounts do not offer private token statistics', () => {
  account.user = null;
  render(<AccountMenu />);
  fireEvent.click(screen.getByRole('button', { name: '账户菜单：登录账户' }));
  expect(screen.queryByRole('menuitem', { name: 'Token 用量统计' })).toBeNull();
});
