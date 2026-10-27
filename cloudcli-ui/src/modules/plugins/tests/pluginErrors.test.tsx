import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import { ClaudeUsageContent } from '@/modules/plugins/ClaudeUsageContent';
import PluginSettingsTab from '@/modules/plugins/PluginSettingsTab';
import { PluginsProvider, usePlugins } from '@/modules/plugins/context/PluginsContext';
import { api } from '@/shared/api';

const auth = vi.hoisted(() => ({ user: { id: 1 } as { id: number; username?: string } | null, isLoading: false }));
vi.mock('@/modules/auth', () => ({ useAuth: () => auth }));
vi.mock('@/modules/plugins/PluginTabContent', () => ({
  default: function MockPluginContent() {
    const [count, setCount] = React.useState(0);
    return <button onClick={() => setCount(value => value + 1)}>额度内容计数 {count}</button>;
  },
}));
const usagePlugin = {
  name: 'claude-usage', displayName: 'Claude Usage', description: '', version: '1.0.0',
  author: '', icon: 'Puzzle', type: 'module', slot: 'tab', entry: 'dist/index.js',
  server: 'dist/server.js', enabled: false, permissions: [], dirName: 'claude-usage', repoUrl: null,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function CatalogProbe() {
  const { refreshPlugins } = usePlugins();
  return <><button onClick={() => void refreshPlugins()}>刷新插件目录</button><ClaudeUsageContent /></>;
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); auth.user = { id: 1 }; });

test('bundled plugin settings only expose switches and keep failed switches usable', async () => {
  await i18n.changeLanguage('zh-CN');
  vi.spyOn(api.plugins, 'list').mockImplementation(async () => Response.json({ plugins: [usagePlugin] }));
  const toggle = vi.spyOn(api.plugins, 'toggle').mockImplementation(async () => Response.json({
    success: false, error: { code: 'PLUGIN_SERVER_UNAVAILABLE', message: 'Cannot load server dependency' },
  }, { status: 400 }));
  render(<PluginsProvider><PluginSettingsTab /></PluginsProvider>);
  await screen.findByText('Claude 额度');
  const control = screen.getByRole('switch', { name: 'Claude 额度 · 启用' });
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.queryByRole('button', { name: /安装|卸载|更新/ })).toBeNull();
  fireEvent.click(control);
  await screen.findByText('Cannot load server dependency');
  expect(toggle).toHaveBeenCalledOnce();
  expect(toggle).toHaveBeenCalledWith('claude-usage', true);
  expect(screen.getByText('Claude 额度')).toBeTruthy();
  expect((control as HTMLInputElement).disabled).toBe(false);
  expect((control as HTMLInputElement).checked).toBe(false);
});

test('plugin list and mutation errors remain text for structured and legacy responses', async () => {
  vi.spyOn(api.plugins, 'list').mockResolvedValue(Response.json({
    error: { code: 'UNAVAILABLE', message: '插件列表不可用', details: { retry: false } },
  }, { status: 503 }));
  vi.spyOn(api.plugins, 'toggle').mockResolvedValue(Response.json({ error: { message: '无法切换插件' } }, { status: 400 }));
  function Probe() {
    const state = usePlugins();
    const [result, setResult] = React.useState('');
    return <><p>{state.pluginsError}</p><button onClick={async () => {
      const result = await state.togglePlugin('demo', true);
      setResult(result.error ?? '');
    }}>检查操作</button><p>{result}</p></>;
  }
  render(<PluginsProvider><Probe /></PluginsProvider>);
  await screen.findByText('插件列表不可用');
  fireEvent.click(screen.getByText('检查操作'));
  await screen.findByText('无法切换插件');
});

test('login loads the catalog and a reply after logout cannot restore plugins', async () => {
  auth.user = null;
  let finishRequest: ((response: Response) => void) | undefined;
  const list = vi.spyOn(api.plugins, 'list').mockImplementation(() => new Promise((resolve) => { finishRequest = resolve; }));
  function Probe() {
    const state = usePlugins();
    return <p>{state.plugins.map((plugin) => plugin.name).join(',') || 'empty'}</p>;
  }
  const view = render(<PluginsProvider><Probe /></PluginsProvider>);
  expect(list).not.toHaveBeenCalled();
  auth.user = { id: 1 };
  view.rerender(<PluginsProvider><Probe /></PluginsProvider>);
  expect(list).toHaveBeenCalledOnce();
  auth.user = null;
  view.rerender(<PluginsProvider><Probe /></PluginsProvider>);
  await act(async () => finishRequest?.(Response.json({ plugins: [usagePlugin] })));
  expect(screen.getByText('empty')).toBeTruthy();
  expect(screen.queryByText('claude-usage')).toBeNull();
});

test.each([1, 2])('changing account to id %i discards old quota content even when the catalog is identical', async (id) => {
  auth.user = { id: 1, username: 'first' };
  const nextAccount = deferred<Response>();
  vi.spyOn(api.plugins, 'list')
    .mockResolvedValueOnce(Response.json({ plugins: [{ ...usagePlugin, enabled: true }] }))
    .mockReturnValueOnce(nextAccount.promise);
  const view = render(<PluginsProvider><ClaudeUsageContent /></PluginsProvider>);
  const oldContent = await screen.findByRole('button', { name: '额度内容计数 0' });
  fireEvent.click(oldContent);
  auth.user = { id, username: 'second' };
  view.rerender(<PluginsProvider><ClaudeUsageContent /></PluginsProvider>);
  expect(screen.queryByRole('button', { name: '额度内容计数 1' })).toBeNull();
  await act(async () => { nextAccount.resolve(Response.json({ plugins: [{ ...usagePlugin, enabled: true }] })); });
  const newContent = await screen.findByRole('button', { name: '额度内容计数 0' });
  expect(newContent).not.toBe(oldContent);
});

test('the current usage view can retry its first 499 and load the enabled plugin', async () => {
  await i18n.changeLanguage('zh-CN');
  const list = vi.spyOn(api.plugins, 'list')
    .mockResolvedValueOnce(Response.json({ error: { message: 'Catalog request canceled' } }, { status: 499 }))
    .mockResolvedValueOnce(Response.json({ plugins: [{ ...usagePlugin, enabled: true }] }));
  render(<PluginsProvider><ClaudeUsageContent /></PluginsProvider>);
  expect((await screen.findByRole('alert')).textContent).toBe('Catalog request canceled');

  fireEvent.click(screen.getByRole('button', { name: '重试' }));

  expect(await screen.findByRole('button', { name: '额度内容计数 0' })).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(list).toHaveBeenCalledTimes(2);
});

test('a catalog refresh failure keeps enabled usage content and its local state mounted', async () => {
  await i18n.changeLanguage('zh-CN');
  vi.spyOn(api.plugins, 'list')
    .mockResolvedValueOnce(Response.json({ plugins: [{ ...usagePlugin, enabled: true }] }))
    .mockResolvedValueOnce(Response.json({ error: { message: 'Catalog temporarily unavailable' } }, { status: 503 }));
  render(<PluginsProvider><CatalogProbe /></PluginsProvider>);
  const content = await screen.findByRole('button', { name: '额度内容计数 0' });
  fireEvent.click(content);

  fireEvent.click(screen.getByRole('button', { name: '刷新插件目录' }));
  expect((await screen.findByRole('alert')).textContent).toBe('Catalog temporarily unavailable');

  expect(screen.getByRole('button', { name: '额度内容计数 1' })).toBe(content);
});

test('an older canceled catalog response cannot replace a newer successful usage view', async () => {
  await i18n.changeLanguage('zh-CN');
  const oldRequest = deferred<Response>();
  const list = vi.spyOn(api.plugins, 'list')
    .mockReturnValueOnce(oldRequest.promise)
    .mockResolvedValueOnce(Response.json({ plugins: [{ ...usagePlugin, enabled: true }] }));
  render(<PluginsProvider><CatalogProbe /></PluginsProvider>);

  fireEvent.click(screen.getByRole('button', { name: '刷新插件目录' }));
  const content = await screen.findByRole('button', { name: '额度内容计数 0' });
  fireEvent.click(content);
  await act(async () => {
    oldRequest.resolve(Response.json({ error: { message: 'Old request canceled' } }, { status: 499 }));
  });

  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByRole('button', { name: '额度内容计数 1' })).toBe(content);
  expect(list).toHaveBeenCalledTimes(2);
});

test('loading disables usage retry without unmounting existing content or sending duplicate requests', async () => {
  await i18n.changeLanguage('zh-CN');
  const retryRequest = deferred<Response>();
  const list = vi.spyOn(api.plugins, 'list')
    .mockResolvedValueOnce(Response.json({ plugins: [{ ...usagePlugin, enabled: true }] }))
    .mockResolvedValueOnce(Response.json({ error: { message: 'Catalog request canceled' } }, { status: 499 }))
    .mockReturnValueOnce(retryRequest.promise);
  render(<PluginsProvider><CatalogProbe /></PluginsProvider>);
  const content = await screen.findByRole('button', { name: '额度内容计数 0' });
  fireEvent.click(content);
  fireEvent.click(screen.getByRole('button', { name: '刷新插件目录' }));
  await screen.findByRole('alert');
  const retry = screen.getByRole<HTMLButtonElement>('button', { name: '重试' });

  fireEvent.click(retry);
  expect(retry.disabled).toBe(true);
  expect(screen.getByRole('button', { name: '额度内容计数 1' })).toBe(content);
  fireEvent.click(retry);
  expect(list).toHaveBeenCalledTimes(3);

  await act(async () => { retryRequest.resolve(Response.json({ plugins: [{ ...usagePlugin, enabled: true }] })); });
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByRole('button', { name: '额度内容计数 1' })).toBe(content);
});

test('Chinese resources cover every English key and preserve interpolation parameters', () => {
  const flatten = (value: Record<string, unknown>, prefix = ''): Record<string, string> =>
    Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      return typeof item === 'object' && item !== null
        ? Object.entries(flatten(item as Record<string, unknown>, path))
        : [[path, String(item)]];
    }));
  for (const namespace of ['auth', 'chat', 'common', 'codeEditor', 'git', 'settings', 'sidebar', 'tasks']) {
    const english = flatten(i18n.getResourceBundle('en', namespace));
    const chinese = flatten(i18n.getResourceBundle('zh-CN', namespace));
    for (const [key, text] of Object.entries(english)) {
      expect(chinese[key], `${namespace}:${key}`).toBeDefined();
      const parameters = (value: string) => (value.match(/\{\{[^}]+\}\}/g) ?? []).sort();
      expect(parameters(chinese[key]), `${namespace}:${key}`).toEqual(parameters(text));
    }
  }
  expect(i18n.getFixedT('zh-CN', 'sidebar')('recent.emptyTitle')).toBe('暂无对话');
  expect(i18n.getFixedT('zh-CN', 'settings')('browserUseSettings.enableLabel')).toBe('启用浏览器');
});
