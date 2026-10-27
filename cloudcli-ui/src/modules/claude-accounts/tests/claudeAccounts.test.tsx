import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import { ClaudeAccountsPanel, ClaudeAccountsProvider, ClaudeUsageTrigger } from '@/modules/claude-accounts';
import { useClaudeAccounts } from '@/modules/claude-accounts/context/ClaudeAccountsContext';
import { ClaudeQuotaDisplay } from '@/modules/claude-accounts/ClaudeQuotaDisplay';
import { api } from '@/shared/api';
import type { ClaudeAccountLogin, ClaudeAccountSummary, ClaudeAccountUsage, ClaudeAccountsState } from '@/shared/types';

const accountApi = api.providers.claudeAccounts;
const now = Date.now();
const usage = (percent: number): ClaudeAccountUsage => ({ status: 'ok', windows: [
  { kind: 'session', label: 'Session', usedPercent: percent, resetsAt: now + 7200000 },
  { kind: 'weekly_all', label: 'Weekly', usedPercent: percent / 2, resetsAt: now + 86400000 },
], updatedAt: now, checkedAt: now, error: null, stale: false });
const account = (id: string, name: string, percent: number): ClaudeAccountSummary => ({ id, name, email: `${id}@example.test`, organizationName: null,
  plan: 'Max', needsSignIn: false, createdAt: now, updatedAt: now, usage: usage(percent) });
const initialState = (): ClaudeAccountsState => ({ runtime: { id: 'server', label: '当前服务器' }, activeId: 'a', accounts: [account('a', 'Work', 20), account('b', 'Personal', 80)],
  defaultAccount: null, route: { kind: 'subscription', label: 'Claude subscription', accountId: 'a' } });
let current: ClaudeAccountsState;
function envelope<T>(data: T) { return Response.json({ success: true, data }); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function Probe() {
  const state = useClaudeAccounts();
  return <><output data-testid="active">{state.snapshot?.activeId ?? 'default'}</output><button onClick={() => void state.refresh()}>probe-refresh</button><button onClick={state.openAccounts}>probe-open</button></>;
}
function showPanel() { return render(<ClaudeAccountsProvider><ClaudeAccountsPanel /></ClaudeAccountsProvider>); }
function accountMenu(name: string) {
  const row = within(screen.getByRole('listitem', { name }));
  fireEvent.click(row.getByRole('button', { name: `管理 ${name}` }));
  return within(row.getByRole('menu'));
}
function chooseAccountAction(name: string, action: string) {
  fireEvent.click(accountMenu(name).getByRole('menuitem', { name: action }));
}

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
  current = initialState();
  vi.spyOn(api.user, 'savePreferences').mockResolvedValue(envelope({}));
  vi.spyOn(accountApi, 'state').mockImplementation(async () => envelope(current));
  vi.spyOn(accountApi, 'refresh').mockImplementation(async () => envelope(current));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

test('the default-only overview renders one account and two quota windows without an empty account count', async () => {
  current = { ...initialState(), activeId: null, accounts: [], defaultAccount: account('default', 'Default', 36),
    route: { kind: 'default', label: 'Claude', accountId: null } };
  showPanel();
  const selected = within(await screen.findByRole('list', { name: 'Claude 订阅账号列表' }));
  const defaultAccount = within(selected.getByRole('listitem', { name: '服务器默认账号' }));
  expect(screen.getAllByRole('listitem')).toHaveLength(1);
  expect(screen.getAllByRole('progressbar')).toHaveLength(2);
  expect(defaultAccount.getByRole('progressbar', { name: '5 小时' }).getAttribute('aria-valuenow')).toBe('36');
  expect(defaultAccount.getByRole('progressbar', { name: '本周' }).getAttribute('aria-valuenow')).toBe('18');
  expect(defaultAccount.getAllByText('已用')).toHaveLength(2);
  expect(defaultAccount.getByRole<HTMLButtonElement>('button', { name: '切换到 服务器默认账号' }).disabled).toBe(true);
  expect(defaultAccount.getByRole('button', { name: '管理 服务器默认账号' }).getAttribute('aria-expanded')).toBe('false');
  const menu = accountMenu('服务器默认账号');
  expect(menu.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['账号详情']);
  fireEvent.click(menu.getByRole('menuitem', { name: '账号详情' }));
  expect(defaultAccount.getByText('此账号来自服务器默认 Claude 登录。')).toBeTruthy();
  expect(defaultAccount.getAllByRole('progressbar')).toHaveLength(2);
  expect(screen.queryByRole('region', { name: '其他账号' })).toBeNull();
  expect(screen.queryByText(/0\s*个账号/)).toBeNull();
  expect(screen.queryByText(/尚未添加 Claude 订阅账号/)).toBeNull();
});

test('all accounts share one list with their own quota while only management details need an explicit action', async () => {
  current.defaultAccount = account('default', 'Default', 12);
  current.accounts[1].organizationName = 'Personal organization';
  showPanel();
  const list = within(await screen.findByRole('list', { name: 'Claude 订阅账号列表' }));
  const work = within(list.getByRole('listitem', { name: 'Work' }));
  const personal = within(list.getByRole('listitem', { name: 'Personal' }));
  const defaultAccount = within(list.getByRole('listitem', { name: '服务器默认账号' }));
  expect(screen.getAllByRole('list')).toHaveLength(1);
  expect(list.getAllByRole('listitem')).toHaveLength(3);
  expect(list.getAllByRole('listitem')[0].getAttribute('aria-label')).toBe('Work');
  expect(screen.getAllByRole('listitem', { name: 'Work' })).toHaveLength(1);
  expect(screen.queryByRole('region', { name: '其他账号' })).toBeNull();
  expect(screen.queryByRole('list', { name: '当前订阅账号' })).toBeNull();
  expect(list.getAllByRole('progressbar')).toHaveLength(6);
  expect(work.getByRole('progressbar', { name: '5 小时' }).getAttribute('aria-valuenow')).toBe('20');
  expect(work.getByRole('progressbar', { name: '本周' }).getAttribute('aria-valuenow')).toBe('10');
  expect(personal.getByRole('progressbar', { name: '5 小时' }).getAttribute('aria-valuenow')).toBe('80');
  expect(personal.getByRole('progressbar', { name: '本周' }).getAttribute('aria-valuenow')).toBe('40');
  expect(defaultAccount.getByRole('progressbar', { name: '5 小时' }).getAttribute('aria-valuenow')).toBe('12');
  expect(defaultAccount.getByRole('progressbar', { name: '本周' }).getAttribute('aria-valuenow')).toBe('6');
  for (const row of [work, personal, defaultAccount]) {
    expect(row.getAllByRole('progressbar')).toHaveLength(2);
    expect(row.getAllByText(/后重置/)).toHaveLength(2);
    expect(row.getByText(/^更新于/)).toBeTruthy();
  }
  expect(personal.queryByText('Personal organization')).toBeNull();
  expect(personal.queryByLabelText('账号名称')).toBeNull();
  expect(screen.queryByRole('menu')).toBeNull();
  chooseAccountAction('Personal', '账号详情');
  expect(screen.queryByRole('menu')).toBeNull();
  expect(personal.getByText('Personal organization')).toBeTruthy();
  expect(personal.getByText('登录凭据保存在服务器并自动续期。切换账号或重启软件无需重新授权；仅在授权失效且无法续期时需要重新登录。')).toBeTruthy();
  expect(list.getAllByRole('progressbar')).toHaveLength(6);
  fireEvent.click(personal.getByRole('button', { name: '收起' }));
  expect(personal.queryByText('Personal organization')).toBeNull();
  expect(list.getAllByRole('progressbar')).toHaveLength(6);
});

test('adding an account and quota explanations are explicit on-demand buttons', async () => {
  const onOpenHistory = vi.fn();
  render(<ClaudeAccountsProvider><ClaudeAccountsPanel onOpenHistory={onOpenHistory} /></ClaudeAccountsProvider>);
  const add = await screen.findByRole('button', { name: '添加订阅账号' });
  const help = screen.getByRole('button', { name: '额度说明' });
  expect(add.tagName).toBe('BUTTON');
  expect(add.getAttribute('aria-expanded')).toBe('false');
  expect(help.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByLabelText('账号名称（可选）')).toBeNull();
  expect(screen.getByText('切换在下一轮生效，不中断运行中的任务。')).toBeTruthy();
  expect(screen.queryByText(/正在运行的任务继续使用原账号/)).toBeNull();
  expect(screen.queryByRole('button', { name: '查看历史统计' })).toBeNull();
  fireEvent.click(add);
  expect(add.getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByLabelText('账号名称（可选）')).toBeTruthy();
  fireEvent.click(add);
  expect(screen.queryByLabelText('账号名称（可选）')).toBeNull();
  fireEvent.click(help);
  expect(help.getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByText(/正在运行的任务继续使用原账号/)).toBeTruthy();
  expect(screen.getByText('历史来自服务器会话日志，估算成本不是订阅余额或实际账单。')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '查看历史统计' }));
  expect(onOpenHistory).toHaveBeenCalledTimes(1);
  fireEvent.click(help);
  expect(help.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByText(/正在运行的任务继续使用原账号/)).toBeNull();
});

test('switch uses the chosen account and default selection without interrupting existing tasks', async () => {
  current.defaultAccount = account('default', 'Default', 10);
  const activate = vi.spyOn(accountApi, 'activate').mockImplementation(async id => {
    current = { ...current, activeId: id, route: { kind: id ? 'subscription' : 'default', label: 'Claude', accountId: id } };
    return envelope(current);
  });
  showPanel();
  const personalSwitch = await screen.findByRole('button', { name: '切换到 Personal' });
  const refresh = screen.getByRole<HTMLButtonElement>('button', { name: '刷新所有账号额度' });
  personalSwitch.focus();
  fireEvent.click(personalSwitch);
  await waitFor(() => expect(activate).toHaveBeenCalledWith('b', expect.objectContaining({ signal: expect.any(AbortSignal) })));
  await waitFor(() => expect(within(screen.getByRole('listitem', { name: 'Personal' })).getByRole<HTMLButtonElement>('button', { name: '切换到 Personal' }).disabled).toBe(true));
  await waitFor(() => expect(document.activeElement).toBe(refresh));
  expect(screen.getByText('切换在下一轮生效，不中断运行中的任务。')).toBeTruthy();
  const defaultSwitch = screen.getByRole('button', { name: '切换到 服务器默认账号' });
  defaultSwitch.focus();
  fireEvent.click(defaultSwitch);
  await waitFor(() => expect(activate).toHaveBeenLastCalledWith(null, expect.objectContaining({ signal: expect.any(AbortSignal) })));
  const selectedDefault = within(screen.getByRole('list', { name: 'Claude 订阅账号列表' }));
  expect(selectedDefault.getAllByRole('listitem')[0].getAttribute('aria-label')).toBe('服务器默认账号');
  expect(selectedDefault.getByRole<HTMLButtonElement>('button', { name: '切换到 服务器默认账号' }).disabled).toBe(true);
  await waitFor(() => expect(document.activeElement).toBe(refresh));
  const workSwitch = screen.getByRole('button', { name: '切换到 Work' });
  workSwitch.focus();
  fireEvent.click(workSwitch);
  await waitFor(() => expect(activate).toHaveBeenLastCalledWith('a', expect.objectContaining({ signal: expect.any(AbortSignal) })));
  await waitFor(() => expect(within(screen.getByRole('list', { name: 'Claude 订阅账号列表' })).getAllByRole('listitem')[0].getAttribute('aria-label')).toBe('Work'));
  await waitFor(() => expect(document.activeElement).toBe(refresh));
});

test('an already selected profile can replace an active API route', async () => {
  current.route = { kind: 'api', label: 'Other API', accountId: null };
  const activate = vi.spyOn(accountApi, 'activate').mockImplementation(async id => {
    current = { ...current, route: { kind: 'subscription', label: 'Claude', accountId: id } };
    return envelope(current);
  });
  showPanel();
  const button = await screen.findByRole<HTMLButtonElement>('button', { name: '切换到 Work' });
  expect(button.disabled).toBe(false);
  expect(button.textContent).toBe('使用此订阅');
  fireEvent.click(button);
  await waitFor(() => expect(activate).toHaveBeenCalledWith('a', expect.objectContaining({ signal: expect.any(AbortSignal) })));
});

test('a selected saved profile can replace HiRoute without claiming the subscription route is active', async () => {
  current.route = { kind: 'hiroute', label: 'Team route', accountId: null };
  const activate = vi.spyOn(accountApi, 'activate').mockImplementation(async id => {
    current = { ...current, route: { kind: 'subscription', label: 'Claude', accountId: id } };
    return envelope(current);
  });
  showPanel();
  await screen.findByText('HiRoute · Team route');
  expect(screen.getByText('HiRoute 由会话中选择的模型启用；下方订阅额度不代表所有线路的余额。')).toBeTruthy();
  const work = within(screen.getByRole('listitem', { name: 'Work' }));
  const button = work.getByRole<HTMLButtonElement>('button', { name: '切换到 Work' });
  expect(button.disabled).toBe(false);
  expect(button.textContent).toBe('使用此订阅');
  expect(work.queryByText('已选择')).toBeNull();
  expect(work.getByRole('progressbar', { name: '5 小时' }).getAttribute('aria-valuenow')).toBe('20');
  button.focus();
  fireEvent.click(button);
  await waitFor(() => expect(activate).toHaveBeenCalledWith('a', expect.objectContaining({ signal: expect.any(AbortSignal) })));
  await waitFor(() => expect(work.getByRole<HTMLButtonElement>('button', { name: '切换到 Work' }).disabled).toBe(true));
  expect(work.getByText('已选择')).toBeTruthy();
  expect(screen.queryByText('HiRoute · Team route')).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: '刷新所有账号额度' })));
});

test('rename validates a nonempty label and preserves each account own quota', async () => {
  const rename = vi.spyOn(accountApi, 'rename').mockImplementation(async (id, name) => {
    current = { ...current, accounts: current.accounts.map(row => row.id === id ? { ...row, name } : row) };
    return envelope(current);
  });
  showPanel();
  await screen.findByRole('listitem', { name: 'Personal' });
  chooseAccountAction('Personal', '改名');
  const input = screen.getByLabelText('账号名称');
  fireEvent.change(input, { target: { value: '  ' } });
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '保存名称' }).disabled).toBe(true);
  fireEvent.change(input, { target: { value: 'Private' } });
  fireEvent.click(screen.getByRole('button', { name: '保存名称' }));
  await screen.findByRole('listitem', { name: 'Private' });
  expect(rename).toHaveBeenCalledWith('b', 'Private', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  const personal = within(screen.getByRole('listitem', { name: 'Private' }));
  expect(personal.getByRole('progressbar', { name: '5 小时' }).getAttribute('aria-valuenow')).toBe('80');
  expect(within(screen.getByRole('listitem', { name: 'Work' })).getByRole('progressbar', { name: '5 小时' }).getAttribute('aria-valuenow')).toBe('20');
});

test('code login starts without a URL, polls for authorization and clears the submitted code', async () => {
  const starting: ClaudeAccountLogin = { id: 'login-1', accountId: 'c', status: 'starting', url: null, error: null, expiresAt: now + 600000 };
  const waiting = { ...starting, status: 'waiting_code' as const, url: 'https://claude.ai/oauth/authorize?code=true' };
  vi.spyOn(accountApi, 'login').mockResolvedValue(envelope(starting));
  vi.spyOn(accountApi, 'loginStatus').mockResolvedValue(envelope(waiting));
  const submit = vi.spyOn(accountApi, 'submitCode').mockResolvedValue(envelope({ ...waiting, status: 'succeeded' }));
  showPanel();
  await screen.findByRole('listitem', { name: 'Work' });
  fireEvent.click(screen.getByRole('button', { name: '添加订阅账号' }));
  fireEvent.change(screen.getByLabelText('账号名称（可选）'), { target: { value: 'Third' } });
  fireEvent.click(screen.getByRole('button', { name: '开始登录' }));
  await screen.findByText('正在服务器上启动 Claude 登录…');
  expect(screen.queryByRole('link', { name: '打开 Claude 授权页面' })).toBeNull();
  const link = await screen.findByRole('link', { name: '打开 Claude 授权页面' }, { timeout: 5000 });
  expect(link.getAttribute('href')).toContain('https://claude.ai/oauth/authorize');
  fireEvent.change(screen.getByLabelText('一次性授权码'), { target: { value: 'one-time-code' } });
  fireEvent.click(screen.getByRole('button', { name: '提交授权码' }));
  await screen.findByText('登录成功，账号已保存。请在账号列表中选择启用。');
  expect(submit).toHaveBeenCalledWith('login-1', 'one-time-code', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(screen.queryByDisplayValue('one-time-code')).toBeNull();
});

test('a rejected authorization code and its draft survive successful status polls until a corrected submission', async () => {
  const waiting: ClaudeAccountLogin = { id: '77d828fc-c774-41fe-b45c-b64cbfa347dd', accountId: 'c', status: 'waiting_code',
    url: 'https://claude.com/cai/oauth/authorize?code=true&state=fixture', error: null, expiresAt: now + 600000 };
  vi.spyOn(accountApi, 'login').mockResolvedValue(envelope(waiting));
  const poll = vi.spyOn(accountApi, 'loginStatus').mockResolvedValue(envelope(waiting));
  const submit = vi.spyOn(accountApi, 'submitCode')
    .mockResolvedValueOnce(Response.json({ success: false, error: { code: 'CLAUDE_LOGIN_STATE_MISMATCH', message: '此授权码不属于当前登录，请使用当前授权链接重新获取。' } }, { status: 400 }))
    .mockResolvedValueOnce(envelope({ ...waiting, status: 'succeeded' }));
  showPanel();
  await screen.findByRole('listitem', { name: 'Work' });
  fireEvent.click(screen.getByRole('button', { name: '添加订阅账号' }));
  fireEvent.click(screen.getByRole('button', { name: '开始登录' }));
  const code = await screen.findByLabelText('一次性授权码');
  fireEvent.change(code, { target: { value: 'wrong-code#old-state' } });
  fireEvent.click(screen.getByRole('button', { name: '提交授权码' }));
  await screen.findByText('此授权码不属于当前登录，请使用当前授权链接重新获取。');
  expect(screen.getByDisplayValue('wrong-code#old-state')).toBeTruthy();
  await waitFor(() => expect(poll).toHaveBeenCalled(), { timeout: 5000 });
  expect(screen.getByText('此授权码不属于当前登录，请使用当前授权链接重新获取。')).toBeTruthy();
  fireEvent.change(code, { target: { value: 'corrected-code' } });
  fireEvent.click(screen.getByRole('button', { name: '提交授权码' }));
  await screen.findByText('登录成功，账号已保存。请在账号列表中选择启用。');
  expect(submit).toHaveBeenLastCalledWith(waiting.id, 'corrected-code', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(screen.queryByDisplayValue('corrected-code')).toBeNull();
});

test('login cancellation and confirmed account deletion address the displayed account', async () => {
  const login: ClaudeAccountLogin = { id: 'login-2', accountId: 'b', status: 'waiting_code', url: 'https://claude.ai/oauth/authorize', error: null, expiresAt: now + 600000 };
  vi.spyOn(accountApi, 'login').mockResolvedValue(envelope(login));
  const cancel = vi.spyOn(accountApi, 'cancelLogin').mockResolvedValue(envelope({ ...login, status: 'cancelled' }));
  const remove = vi.spyOn(accountApi, 'remove').mockImplementation(async id => {
    current = { ...current, accounts: current.accounts.filter(row => row.id !== id) };
    return envelope(current);
  });
  showPanel();
  const personal = within(await screen.findByRole('listitem', { name: 'Personal' }));
  chooseAccountAction('Personal', '重新登录');
  fireEvent.click(await screen.findByRole('button', { name: '取消此次登录' }));
  await screen.findByText('此次登录已取消。');
  expect(cancel).toHaveBeenCalledWith('login-2', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  chooseAccountAction('Personal', '删除');
  expect(remove).not.toHaveBeenCalled();
  fireEvent.click(personal.getByRole('button', { name: '确认删除' }));
  await waitFor(() => expect(screen.queryByRole('listitem', { name: 'Personal' })).toBeNull());
  expect(remove).toHaveBeenCalledWith('b', expect.objectContaining({ signal: expect.any(AbortSignal) }));
});

test('deleting the current saved account applies the returned default selection and restores focus to refresh', async () => {
  current.defaultAccount = account('default', 'Default', 10);
  const removed = deferred<Response>();
  const remove = vi.spyOn(accountApi, 'remove').mockReturnValueOnce(removed.promise);
  render(<ClaudeAccountsProvider><Probe /><ClaudeAccountsPanel /></ClaudeAccountsProvider>);
  const work = within(await screen.findByRole('listitem', { name: 'Work' }));
  const refresh = screen.getByRole<HTMLButtonElement>('button', { name: '刷新所有账号额度' });
  await waitFor(() => expect(refresh.disabled).toBe(false));
  chooseAccountAction('Work', '删除');
  expect(remove).not.toHaveBeenCalled();
  expect(screen.getByTestId('active').textContent).toBe('a');
  const confirm = work.getByRole<HTMLButtonElement>('button', { name: '确认删除' });
  confirm.focus();
  fireEvent.click(confirm);
  expect(remove).toHaveBeenCalledWith('a', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(screen.getByTestId('active').textContent).toBe('a');
  expect(screen.getByRole('listitem', { name: 'Work' })).toBeTruthy();
  const next: ClaudeAccountsState = { ...current, activeId: null, accounts: current.accounts.filter(row => row.id !== 'a'),
    defaultAccount: account('default', 'Default', 64), route: { kind: 'default', label: 'Claude', accountId: null } };
  const quotaRead = deferred<Response>();
  vi.mocked(accountApi.refresh).mockReturnValueOnce(quotaRead.promise);
  await act(async () => { removed.resolve(envelope(next)); });
  expect(screen.getByTestId('active').textContent).toBe('default');
  expect(screen.queryByRole('listitem', { name: 'Work' })).toBeNull();
  const list = within(screen.getByRole('list', { name: 'Claude 订阅账号列表' }));
  expect(list.getAllByRole('listitem')[0].getAttribute('aria-label')).toBe('服务器默认账号');
  const selected = within(list.getByRole('listitem', { name: '服务器默认账号' }));
  expect(selected.getByRole<HTMLButtonElement>('button', { name: '切换到 服务器默认账号' }).disabled).toBe(true);
  expect(selected.getByRole('progressbar', { name: '5 小时' }).getAttribute('aria-valuenow')).toBe('64');
  expect(selected.getByRole('progressbar', { name: '本周' }).getAttribute('aria-valuenow')).toBe('32');
  expect(list.getByRole('listitem', { name: 'Personal' })).toBeTruthy();
  expect(list.getAllByRole('progressbar')).toHaveLength(4);
  expect(accountApi.refresh).toHaveBeenLastCalledWith({ id: null }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  // Let the first focus frame run while quota is pending, as it would with a slower server.
  await act(async () => { await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve())); });
  current = next;
  await act(async () => { quotaRead.resolve(envelope(next)); });
  await waitFor(() => expect(document.activeElement).toBe(refresh));
});

test('changing the App provider identity discards the previous account rename draft', async () => {
  const rename = vi.spyOn(accountApi, 'rename');
  const view = render(<ClaudeAccountsProvider key="first"><ClaudeAccountsPanel /></ClaudeAccountsProvider>);
  await screen.findByRole('listitem', { name: 'Personal' });
  chooseAccountAction('Personal', '改名');
  fireEvent.change(screen.getByLabelText('账号名称'), { target: { value: 'Private draft' } });
  expect(screen.getByDisplayValue('Private draft')).toBeTruthy();
  current = { ...initialState(), accounts: [account('a', 'Team Work', 14), account('b', 'Team Personal', 72)] };
  view.rerender(<ClaudeAccountsProvider key="second"><ClaudeAccountsPanel /></ClaudeAccountsProvider>);
  const personal = within(await screen.findByRole('listitem', { name: 'Team Personal' }));
  expect(screen.queryByLabelText('账号名称')).toBeNull();
  expect(screen.queryByDisplayValue('Private draft')).toBeNull();
  expect(personal.getByRole('button', { name: '管理 Team Personal' }).getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('menu')).toBeNull();
  expect(rename).not.toHaveBeenCalled();
  chooseAccountAction('Team Personal', '改名');
  expect(personal.getByLabelText<HTMLInputElement>('账号名称').value).toBe('Team Personal');
});

test('a failed row login opens a retryable form even when add-account fields were closed', async () => {
  current.accounts[1].needsSignIn = true;
  const login = vi.spyOn(accountApi, 'login')
    .mockResolvedValueOnce(Response.json({ success: false, error: { message: 'Claude CLI unavailable' } }, { status: 503 }))
    .mockResolvedValueOnce(envelope<ClaudeAccountLogin>({ id: 'login-retry', accountId: 'c', status: 'waiting_code',
      url: 'https://claude.ai/oauth/authorize', error: null, expiresAt: now + 600000 }));
  showPanel();
  const personal = within(await screen.findByRole('listitem', { name: 'Personal' }));
  expect(screen.queryByLabelText('账号名称（可选）')).toBeNull();
  expect(personal.getByRole<HTMLButtonElement>('button', { name: '切换到 Personal' }).disabled).toBe(true);
  expect(personal.getByText('需要重新登录')).toBeTruthy();
  chooseAccountAction('Personal', '重新登录');
  await screen.findByRole('alert');
  expect(screen.getByText('Claude CLI unavailable')).toBeTruthy();
  expect(login).toHaveBeenCalledWith({ accountId: 'b' }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(screen.getByRole('button', { name: '添加订阅账号' }).getAttribute('aria-expanded')).toBe('true');
  const name = screen.getByLabelText('账号名称（可选）');
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '开始登录' }).disabled).toBe(false);
  fireEvent.change(name, { target: { value: '  Replacement  ' } });
  fireEvent.click(screen.getByRole('button', { name: '开始登录' }));
  await screen.findByRole('link', { name: '打开 Claude 授权页面' });
  expect(login).toHaveBeenLastCalledWith({ name: 'Replacement' }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(screen.queryByText('Claude CLI unavailable')).toBeNull();
  expect(screen.getByLabelText('一次性授权码')).toBeTruthy();
});

test('unknown quota, stale readings and API billing remain distinct from zero percent', async () => {
  current = { ...initialState(), activeId: null, accounts: [], defaultAccount: null, route: { kind: 'api', label: 'Private gateway', accountId: null } };
  const view = showPanel();
  await screen.findByText('API 连接 · Private gateway');
  expect(screen.getByText(/尚未添加 Claude 订阅账号/)).toBeTruthy();
  expect(screen.queryByRole('list')).toBeNull();
  expect(screen.queryByText(/已用 0%|5 小时 0%|本周 0%/)).toBeNull();
  expect(screen.queryByRole('progressbar')).toBeNull();
  expect(screen.queryByRole('button', { name: '切换到 服务器默认账号' })).toBeNull();
  expect(screen.getByText(/两者计费独立/)).toBeTruthy();
  view.unmount();
  current = initialState();
  current.accounts[0].usage = { ...usage(22), status: 'unavailable', windows: [], updatedAt: null };
  const unknown = showPanel();
  const unknownWork = within(await screen.findByRole('listitem', { name: 'Work' }));
  expect(unknownWork.getByText('额度暂不可用')).toBeTruthy();
  expect(unknownWork.getByText('尚无成功更新记录')).toBeTruthy();
  expect(unknownWork.queryByRole('progressbar')).toBeNull();
  expect(unknownWork.queryByText(/0%/)).toBeNull();
  unknown.unmount();
  current = initialState();
  current.accounts[0].usage = { ...usage(22), status: 'error', stale: true, error: '暂时无法联网' };
  showPanel();
  await screen.findAllByText('当前为上次成功读取的数据，刷新后可能变化。');
  expect(screen.getAllByText('暂时无法联网').length).toBeGreaterThan(0);
  expect(screen.getAllByRole('progressbar', { name: '5 小时' })[0].getAttribute('aria-valuenow')).toBe('22');
});

test('a no-subscription reading has a meaningful explanation instead of an empty gauge', async () => {
  current.accounts[0].usage = { ...usage(20), status: 'unavailable', windows: [], failureKind: 'no-subscription' };
  showPanel();
  await screen.findAllByText('无订阅额度 · API 按量计费');
  expect(within(screen.getByRole('listitem', { name: 'Work' })).queryByRole('progressbar')).toBeNull();
});

test('an outgoing refresh cannot overwrite a newly selected account even when its transport ignores abort', async () => {
  const oldRead = deferred<Response>();
  const refresh = vi.mocked(accountApi.refresh).mockReturnValueOnce(oldRead.promise).mockImplementation(async () => envelope(current));
  vi.spyOn(accountApi, 'activate').mockImplementation(async id => {
    current = { ...current, activeId: id, route: { kind: 'subscription', label: 'Claude', accountId: id } };
    return envelope(current);
  });
  render(<ClaudeAccountsProvider><Probe /><ClaudeAccountsPanel /></ClaudeAccountsProvider>);
  await screen.findByRole('button', { name: '切换到 Personal' });
  await waitFor(() => expect(refresh).toHaveBeenCalled());
  const outgoing = initialState();
  fireEvent.click(screen.getByRole('button', { name: '切换到 Personal' }));
  await waitFor(() => expect(screen.getByTestId('active').textContent).toBe('b'));
  await act(async () => { oldRead.resolve(envelope(outgoing)); });
  expect(screen.getByTestId('active').textContent).toBe('b');
});

test('changing the App provider key discards late reads from the previous Chisa account', async () => {
  const oldRead = deferred<Response>();
  vi.mocked(accountApi.state).mockReturnValueOnce(oldRead.promise).mockResolvedValueOnce(envelope({ ...current, activeId: 'b' }));
  const view = render(<ClaudeAccountsProvider key="first"><Probe /></ClaudeAccountsProvider>);
  view.rerender(<ClaudeAccountsProvider key="second"><Probe /></ClaudeAccountsProvider>);
  await waitFor(() => expect(screen.getByTestId('active').textContent).toBe('b'));
  await act(async () => { oldRead.resolve(envelope(initialState())); });
  expect(screen.getByTestId('active').textContent).toBe('b');
});

test('opening during the initial request still fetches inactive quota', async () => {
  const initial = deferred<Response>();
  vi.mocked(accountApi.state).mockReturnValueOnce(initial.promise);
  render(<ClaudeAccountsProvider><ClaudeAccountsPanel /></ClaudeAccountsProvider>);
  await screen.findByRole('listitem', { name: 'Work' });
  expect(accountApi.refresh).toHaveBeenCalledWith({ all: true }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  await act(async () => { initial.resolve(envelope(initialState())); });
  expect(screen.getByRole('listitem', { name: 'Personal' })).toBeTruthy();
});

test('successful inactive reads debounce repeated openings for sixty seconds', async () => {
  vi.useFakeTimers();
  render(<ClaudeAccountsProvider><Probe /></ClaudeAccountsProvider>);
  await act(async () => {});
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'probe-open' })); });
  expect(accountApi.refresh).toHaveBeenCalledTimes(1);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'probe-open' })); });
  expect(accountApi.refresh).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'probe-open' })); });
  expect(accountApi.refresh).toHaveBeenCalledTimes(2);
});

test('automatic refresh pauses while hidden, uses five-minute focus freshness and fifteen-minute cadence', async () => {
  vi.useFakeTimers();
  const shown = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const refresh = vi.mocked(accountApi.refresh).mockImplementation(async () => {
    current = { ...current, accounts: current.accounts.map(row => row.id === current.activeId ? { ...row, usage: { ...row.usage, checkedAt: Date.now() } } : row) };
    return envelope(current);
  });
  render(<ClaudeAccountsProvider><Probe /></ClaudeAccountsProvider>);
  await act(async () => {});
  act(() => window.dispatchEvent(new Event('focus')));
  expect(refresh).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  expect(refresh).toHaveBeenCalledTimes(1);
  shown.mockReturnValue('hidden');
  await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000); });
  expect(refresh).toHaveBeenCalledTimes(1);
  shown.mockReturnValue('visible');
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  expect(refresh).toHaveBeenCalledTimes(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(15 * 60_000); });
  expect(refresh).toHaveBeenCalledTimes(3);
});

test('a failed switch preserves the old selection and error while a failed login remains actionable', async () => {
  vi.spyOn(accountApi, 'activate').mockResolvedValue(Response.json({ success: false, error: { message: 'Account unavailable' } }, { status: 409 }));
  vi.spyOn(accountApi, 'login').mockResolvedValue(Response.json({ success: false, error: { message: 'Claude CLI unavailable' } }, { status: 503 }));
  showPanel();
  fireEvent.click(await screen.findByRole('button', { name: '切换到 Personal' }));
  await screen.findByText('Account unavailable');
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '切换到 Work' }).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '添加订阅账号' }));
  fireEvent.click(screen.getByRole('button', { name: '开始登录' }));
  await screen.findByText('Claude CLI unavailable');
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '开始登录' }).disabled).toBe(false);
});

test('a quota window disappears at its reset instead of becoming a false zero-percent reading', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  render(<ClaudeQuotaDisplay usage={{ ...usage(92), windows: [{ kind: 'session', label: 'Session', usedPercent: 92, resetsAt: now + 10_000 }] }} />);
  expect(screen.getByRole('progressbar', { name: '5 小时' }).getAttribute('aria-valuenow')).toBe('92');
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(screen.queryByRole('progressbar')).toBeNull();
  expect(screen.getByText('窗口已到重置时间，等待更新')).toBeTruthy();
  expect(screen.queryByText('已用 0%')).toBeNull();
});

test('unsafe authorization URLs are not rendered as links and user codes remain private', async () => {
  const login: ClaudeAccountLogin = { id: 'login-unsafe', accountId: 'b', status: 'waiting_code', url: 'https://example.test/phishing', error: null, expiresAt: now + 600000 };
  vi.spyOn(accountApi, 'login').mockResolvedValue(envelope(login));
  showPanel();
  await screen.findByRole('listitem', { name: 'Personal' });
  chooseAccountAction('Personal', '重新登录');
  await screen.findByText('服务器返回的授权地址无法安全打开，请取消后重试。');
  expect(screen.queryByRole('link', { name: '打开 Claude 授权页面' })).toBeNull();
  expect(screen.queryByLabelText('一次性授权码')).toBeNull();
});

test('account menus expose management actions and support keyboard navigation without borrowing another row state', async () => {
  const remove = vi.spyOn(accountApi, 'remove');
  showPanel();
  const personal = within(await screen.findByRole('listitem', { name: 'Personal' }));
  const trigger = personal.getByRole('button', { name: '管理 Personal' });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  const menu = personal.getByRole('menu');
  const actions = within(menu);
  expect(actions.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['账号详情', '改名', '重新登录', '删除']);
  expect(document.activeElement).toBe(actions.getByRole('menuitem', { name: '账号详情' }));
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(actions.getByRole('menuitem', { name: '改名' }));
  fireEvent.keyDown(document.activeElement!, { key: 'End' });
  expect(document.activeElement).toBe(actions.getByRole('menuitem', { name: '删除' }));
  fireEvent.click(actions.getByRole('menuitem', { name: '删除' }));
  expect(screen.queryByRole('menu')).toBeNull();
  expect(remove).not.toHaveBeenCalled();
  expect(personal.getByText(/删除 Personal 的已保存登录/)).toBeTruthy();
  fireEvent.click(personal.getByRole('button', { name: '保留账号' }));
  expect(personal.queryByRole('button', { name: '确认删除' })).toBeNull();
  chooseAccountAction('Work', '改名');
  expect(within(screen.getByRole('listitem', { name: 'Work' })).getByLabelText<HTMLInputElement>('账号名称').value).toBe('Work');
  expect(personal.queryByLabelText('账号名称')).toBeNull();
  fireEvent.click(within(screen.getByRole('listitem', { name: 'Work' })).getByRole('button', { name: '取消' }));
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(screen.queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

test('Escape closes the account menu before the dialog and restores each trigger in order', async () => {
  render(<ClaudeAccountsProvider><ClaudeUsageTrigger /></ClaudeAccountsProvider>);
  const trigger = screen.getByRole('button', { name: '打开 Claude 账号与额度' });
  trigger.focus();
  fireEvent.click(trigger);
  const dialog = await screen.findByRole('dialog', { name: 'Claude 账号与额度' });
  const management = await within(dialog).findByRole('button', { name: '管理 Personal' });
  // Wait for the dialog initial-focus frame before deliberately moving into its menu.
  await act(async () => { await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve())); });
  management.focus();
  fireEvent.keyDown(management, { key: 'ArrowDown' });
  const menu = within(dialog).getByRole('menu');
  expect(document.activeElement).toBe(within(menu).getByRole('menuitem', { name: '账号详情' }));
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(screen.getByRole('dialog', { name: 'Claude 账号与额度' })).toBe(dialog);
  expect(within(dialog).queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(management);
  fireEvent.keyDown(management, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(document.activeElement).toBe(trigger);
});

test('the compact trigger is permanently visible and opens a focusable dialog', async () => {
  render(<ClaudeAccountsProvider><ClaudeUsageTrigger /></ClaudeAccountsProvider>);
  const button = screen.getByRole('button', { name: '打开 Claude 账号与额度' });
  expect(button).toBeTruthy();
  button.focus();
  fireEvent.click(button);
  const dialog = await screen.findByRole('dialog', { name: 'Claude 账号与额度' });
  const close = within(dialog).getByRole('button', { name: '关闭账号与额度' });
  close.focus();
  fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
  expect(dialog.contains(document.activeElement)).toBe(true);
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(document.activeElement).toBe(button);
});
