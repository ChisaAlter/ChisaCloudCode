import assert from 'node:assert/strict';
import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { PaletteOpsProvider, usePaletteOpsRegister } from '@/modules/command-palette';
import { PiAgentPanel, PiAgentSettings } from '@/modules/local-agent';
import type { ChisaSyncInfo, PiAttachmentInput, PiConfigInput, PiConfigView, PiSessionView } from '@/shared/types';

const bridge = vi.hoisted(() => ({ getState: vi.fn(), piGetConfig: vi.fn(), piSaveConfig: vi.fn(), piInstall: vi.fn(), piGetSession: vi.fn(), piEvents: vi.fn(), piPrompt: vi.fn(), piAbort: vi.fn(), piRecoverSession: vi.fn() }));
const notifications = vi.hoisted(() => ({
  sync: new Set<(info: ChisaSyncInfo) => void>(),
  connection: new Set<() => void>(),
  config: new Set<(view: PiConfigView) => void>(),
}));
// Native IPC is replaced; real components receive the same notification contract as shared/chisa.
vi.mock('@/shared/chisa', () => ({
  FrontendBridge: {
    ...bridge,
    piSaveConfig: async (input: PiConfigInput) => {
      const view = await bridge.piSaveConfig(input);
      if (view.ok !== false) notifications.config.forEach(listener => listener(view));
      return view;
    },
  },
  onWorkspaceSyncStateChanged: (listener: (info: ChisaSyncInfo) => void) => {
    notifications.sync.add(listener);
    return () => { notifications.sync.delete(listener); };
  },
  onWorkspaceConnectionChanged: (listener: () => void) => {
    notifications.connection.add(listener);
    return () => { notifications.connection.delete(listener); };
  },
  onPiConfigChanged: (listener: (view: PiConfigView) => void) => {
    notifications.config.add(listener);
    return () => { notifications.config.delete(listener); };
  },
}));
const openFileInEditor = vi.fn();
// Markdown uses the actual palette context; only its Cloud editor operation is observed.
function ObservePaletteFileOpen() {
  usePaletteOpsRegister({ openFileInEditor });
  return null;
}
function PaletteContext({ children }: { children: ReactNode }) {
  return <PaletteOpsProvider><ObservePaletteFileOpen />{children}</PaletteOpsProvider>;
}
const config: PiConfigView = { ok: true, installed: true, version: '1.0.2', provider: 'custom', model: 'example-model', baseUrl: 'https://api.example.test/v1', api: 'openai-completions', hasApiKey: true, configured: true };
const sessionView = (patch: Partial<PiSessionView> = {}): PiSessionView => ({ ok: true, owner: 'claude', running: false, runtimeActive: false, cursor: 0, messages: [], lastResult: null, events: [], ...patch });
function deferred<T>() { let resolve!: (value:T)=>void; const promise = new Promise<T>(done=>{resolve=done;}); return {promise,resolve}; }
async function mount(extra: Partial<Parameters<typeof PiAgentPanel>[0]> = {}) {
  const spies = { onInputChange: vi.fn(), getClaudeContext: vi.fn().mockResolvedValue('current Claude conversation and tool results'), onOwnershipChange: vi.fn(), onEligibilityChange: vi.fn(), onClose: vi.fn() };
  const props = { serverPath: '/srv/local', sessionId: 'session-a', isActive: true, cloudBusy: false, input: '', ...spies, ...extra };
  let view!: ReturnType<typeof render>;
  const onInputChange = props.onInputChange;
  props.onInputChange = (text: string) => {
    onInputChange(text);
    props.input = text;
    view.rerender(<PiAgentPanel key={props.sessionId} {...props}/>);
  };
  await act(async()=>{view=render(<PiAgentPanel key={props.sessionId} {...props}/>,{wrapper:PaletteContext});});
  return {view,props,spies};
}
beforeEach(()=>{
  vi.resetAllMocks();
  notifications.sync.clear();
  notifications.connection.clear();
  notifications.config.clear();
  bridge.getState.mockResolvedValue({mappings:[{serverPath:'/srv/local',localPath:'C:\\project'}]});
  bridge.piGetConfig.mockResolvedValue(config);
  bridge.piGetSession.mockResolvedValue(sessionView());
  bridge.piEvents.mockResolvedValue(sessionView());
  bridge.piPrompt.mockImplementation((_path, _id, message, _context, files: PiAttachmentInput[] = []) => Promise.resolve(sessionView({ owner: 'pi', running: true, messages: [{ id: 'native-user', role: 'user', content: message, timestamp: new Date().toISOString(), attachments: files.map((file) => ({ name: file.name, mimeType: file.mimeType, size: Buffer.from(file.dataBase64, 'base64').length, path: `C:\\Pi\\${file.name}` })) }] })));
  bridge.piAbort.mockResolvedValue(sessionView());
  bridge.piSaveConfig.mockImplementation((input: PiConfigInput) => Promise.resolve({
    ...config, provider: input.provider, model: input.model, baseUrl: input.baseUrl.replace(/\/+$/, ''), api: input.api,
  }));
  bridge.piInstall.mockResolvedValue({ ok: true });
});
afterEach(()=>{cleanup();vi.useRealTimers();});

test('incremental polling retains old history, updates streaming messages and restores expired cursors', async () => {
  vi.useFakeTimers();
  const older = { id: 'old', role: 'user' as const, content: 'older retained message', timestamp: '2026-10-05T01:00:00Z' };
  const stream = { id: 'stream', role: 'assistant' as const, content: 'initial streamed answer', timestamp: '2026-10-05T01:01:00Z' };
  bridge.piGetSession.mockResolvedValue(sessionView({ cursor: 5, messagesReset: true, messages: [older, stream] }));
  bridge.piEvents.mockResolvedValueOnce(sessionView({ cursor: 6, messagesReset: false, messages: [{ ...stream, content: 'updated streamed answer' }] }))
    .mockResolvedValueOnce(sessionView({ cursor: 6, messagesReset: false, messages: [] }))
    .mockResolvedValueOnce(sessionView({ cursor: 600, messagesReset: true, messages: [older, { ...stream, content: 'recovered complete answer' }] }));
  await mount();
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  assert.ok(screen.getByText('older retained message'));
  assert.ok(screen.getByText('updated streamed answer'));
  assert.equal(screen.queryByText('initial streamed answer'), null);
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  assert.equal(screen.getAllByText('updated streamed answer').length, 1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  assert.ok(screen.getByText('recovered complete answer'));
  assert.equal(document.querySelectorAll('article').length, 2);
  assert.deepEqual(bridge.piEvents.mock.calls.map(call => call[2]), [5, 6, 6]);
});

test('Pi plus opens its own picker, allows removal, and sends selected file bytes without text', async () => {
  const { spies } = await mount();
  const picker = screen.getByLabelText('Pi 上传文件') as HTMLInputElement;
  const clicked = vi.spyOn(picker, 'click');
  fireEvent.click(screen.getByRole('button', { name: 'Pi 添加附件' }));
  assert.equal(clicked.mock.calls.length, 1);
  fireEvent.change(picker, { target: { files: [new File(['附件内容'], '说明.txt', { type: 'text/plain' }), new File(['discard'], '移除.txt')] } });
  assert.equal(spies.getClaudeContext.mock.calls.length, 0);
  fireEvent.click(screen.getByRole('button', { name: '移除附件 移除.txt' }));
  assert.equal(screen.queryByText('移除.txt'), null);
  assert.equal((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled, false);
  await act(async () => { fireEvent.keyDown(screen.getByRole('textbox', { name: 'Pi 输入' }), { key: 'Enter' }); });
  await waitFor(() => assert.equal(bridge.piPrompt.mock.calls.length, 1));
  assert.deepEqual(bridge.piPrompt.mock.calls[0], ['/srv/local', 'session-a', '请查看附件。', 'current Claude conversation and tool results', [{ name: '说明.txt', mimeType: 'text/plain', dataBase64: Buffer.from('附件内容').toString('base64') }]]);
  assert.ok(screen.getByText('说明.txt').closest('article'));
  assert.equal(screen.queryByRole('button', { name: '移除附件 说明.txt' }), null);
});

test('failed Pi submission retains attachments for retry and does not discard a newly selected draft file', async () => {
  const context = deferred<string>();
  const getClaudeContext = vi.fn().mockReturnValue(context.promise);
  await mount({ input: '看看附件', getClaudeContext });
  const picker = screen.getByLabelText('Pi 上传文件');
  fireEvent.change(picker, { target: { files: [new File(['first'], '第一份.txt')] } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '发送' })); });
  await waitFor(() => assert.equal(getClaudeContext.mock.calls.length, 1));
  fireEvent.change(picker, { target: { files: [new File(['next'], '下一份.txt')] } });
  bridge.piPrompt.mockResolvedValue({ ok: false, error: '附件保存失败' });
  await act(async () => { context.resolve('reference'); });
  await waitFor(() => assert.ok(screen.getByRole('button', { name: '移除附件 第一份.txt' })));
  assert.ok(screen.getByRole('button', { name: '移除附件 下一份.txt' }));
  assert.match(screen.getByRole('status').textContent || '', /附件保存失败/);
  assert.ok(screen.getAllByText('第一份.txt').some((node) => node.closest('article')));
});

test('Pi attachment limits reject the batch without sending or losing the current draft', async () => {
  const { spies } = await mount({ input: '保留草稿' });
  const picker = screen.getByLabelText('Pi 上传文件');
  const oversized = new File(['a'], '太大.bin');
  Object.defineProperty(oversized, 'size', { value: 10 * 1024 * 1024 + 1 });
  fireEvent.change(picker, { target: { files: [oversized] } });
  assert.match(screen.getByRole('status').textContent || '', /10MB/);
  fireEvent.change(picker, { target: { files: Array.from({ length: 11 }, (_, i) => new File(['a'], `${i}.txt`)) } });
  assert.match(screen.getByRole('status').textContent || '', /10 个/);
  assert.equal(screen.queryByRole('button', { name: /移除附件/ }), null);
  assert.equal((screen.getByRole('textbox', { name: 'Pi 输入' }) as HTMLTextAreaElement).value, '保留草稿');
  assert.equal(spies.getClaudeContext.mock.calls.length, 0);
  assert.equal(bridge.piPrompt.mock.calls.length, 0);
});

test('Pi opens a model picker before custom configuration and saves without exposing a stored key', async () => {
  await mount();
  const trigger = screen.getByRole('button', { name: 'Pi 选择模型' });
  assert.equal(trigger.textContent?.trim(), 'example-model');
  assert.equal(screen.queryByRole('region', { name: '本地 Pi 设置' }), null);
  await act(async () => { fireEvent.click(trigger); });
  const popup = screen.getByRole('menu', { name: 'Pi 选择模型' });
  assert.equal(popup.closest('[aria-label="Pi 独立工作区"]'), null);
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  assert.equal(screen.queryByLabelText('API Key'), null);
  const selectedModel = screen.getByRole('menuitemradio', { name: 'example-model' });
  assert.equal(selectedModel.getAttribute('aria-checked'), 'true');
  fireEvent.click(selectedModel);
  assert.equal(screen.queryByRole('menu', { name: 'Pi 选择模型' }), null);
  assert.equal(document.activeElement, trigger);
  assert.equal(bridge.piSaveConfig.mock.calls.length, 0);
  fireEvent.click(trigger);
  await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: '配置自定义模型' })); });
  assert.ok(screen.getByRole('dialog', { name: 'Pi 自定义模型配置' }));
  const key = screen.getByLabelText('API Key') as HTMLInputElement;
  assert.equal(key.type, 'password');
  assert.equal(key.value, '');
  assert.equal(key.placeholder, '已保存密钥；留空保留');
  fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'new-model' } });
  fireEvent.change(screen.getByLabelText('API 地址'), { target: { value: 'https://api.example.test/v2/' } });
  assert.match(key.placeholder, /重新填写/);
  fireEvent.change(screen.getByLabelText('API 协议'), { target: { value: 'openai-responses' } });
  fireEvent.change(key, { target: { value: 'test-only-key' } });
  const readsBeforeSave = bridge.piGetConfig.mock.calls.length;
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存模型配置' })); });
  assert.deepEqual(bridge.piSaveConfig.mock.calls[0][0], {
    provider: 'custom', model: 'new-model', baseUrl: 'https://api.example.test/v2/', api: 'openai-responses', apiKey: 'test-only-key',
  });
  assert.equal((screen.getByLabelText('API 地址') as HTMLInputElement).value, 'https://api.example.test/v2');
  assert.equal(key.value, '');
  assert.equal(key.placeholder, '已保存密钥；留空保留');
  assert.match(screen.getByRole('status').textContent || '', /配置已保存/);
  assert.equal(trigger.textContent?.trim(), 'new-model');
  assert.equal(bridge.piGetConfig.mock.calls.length, readsBeforeSave);
  fireEvent.change(screen.getByLabelText('服务商'), { target: { value: 'openai' } });
  assert.equal(screen.queryByLabelText('API 协议'), null);
  assert.match(key.placeholder, /重新填写/);
  fireEvent.change(screen.getByLabelText('服务商'), { target: { value: 'custom' } });
  fireEvent.change(screen.getByLabelText('API 地址'), { target: { value: '' } });
  assert.equal((screen.getByRole('button', { name: '保存模型配置' }) as HTMLButtonElement).disabled, true);
  fireEvent.click(screen.getByRole('button', { name: '返回模型列表' }));
  assert.equal(screen.getByRole('menuitemradio', { name: 'new-model' }).getAttribute('aria-checked'), 'true');
  assert.equal(screen.queryByLabelText('API Key'), null);
  fireEvent.pointerDown(screen.getByRole('textbox', { name: 'Pi 输入' }));
  assert.equal(screen.queryByRole('menu', { name: 'Pi 选择模型' }), null);
  fireEvent.click(trigger);
  fireEvent.keyDown(window, { key: 'Escape' });
  assert.equal(screen.queryByRole('menu', { name: 'Pi 选择模型' }), null);
  assert.equal(document.activeElement, trigger);
});

test('Pi model picker reports a failed configuration read and keeps the configuration entry available', async () => {
  bridge.piGetConfig.mockResolvedValue({ ok: false, error: '无法读取 Pi 配置' });
  await mount();
  fireEvent.click(screen.getByRole('button', { name: 'Pi 选择模型' }));
  assert.match(screen.getByRole('menu', { name: 'Pi 选择模型' }).textContent || '', /无法读取 Pi 配置/);
  assert.equal(screen.queryByRole('menuitemradio'), null);
  await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: '配置自定义模型' })); });
  assert.ok(screen.getByRole('dialog', { name: 'Pi 自定义模型配置' }));
  assert.equal(bridge.piSaveConfig.mock.calls.length, 0);
});

test('Pi reads current Claude context exactly once only when the user sends a task', async()=>{
  const {spies}=await mount({input:'  private task  '});
  assert.equal(spies.getClaudeContext.mock.calls.length,0);
  assert.equal(bridge.piPrompt.mock.calls.length,0);
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'发送'}));});
  assert.equal(spies.getClaudeContext.mock.calls.length,1);
  assert.deepEqual(bridge.piPrompt.mock.calls,[['/srv/local','session-a','private task','current Claude conversation and tool results', []]]);
  assert.deepEqual(spies.onInputChange.mock.calls,[['']]);
  assert.equal(screen.queryByRole('button',{name:'交还 Claude 并继续'}),null);
  assert.equal(screen.queryByRole('button',{name:'转到 Claude 草稿'}),null);
});

test('Enter immediately records the message and clears the composer before delayed context and native acceptance', async () => {
  const context = deferred<string>();
  const accepted = deferred<PiSessionView>();
  const getClaudeContext = vi.fn().mockReturnValue(context.promise);
  bridge.piPrompt.mockReturnValue(accepted.promise);
  const { view, spies } = await mount({ input: '你怎么看', getClaudeContext });
  const textarea = screen.getByRole('textbox', { name: 'Pi 输入' }) as HTMLTextAreaElement;

  await act(async () => { fireEvent.keyDown(textarea, { key: 'Enter' }); });
  assert.equal(textarea.value, '');
  assert.ok(screen.getByText('你怎么看').closest('article'));
  assert.equal(screen.queryByText('继续你的项目'), null);
  assert.ok(screen.getByText('正在读取当前 Claude 对话…').closest('.chat-messages-pane'));
  assert.equal(getClaudeContext.mock.calls.length, 1);
  assert.equal(bridge.piPrompt.mock.calls.length, 0);

  fireEvent.change(textarea, { target: { value: '下一条草稿' } });
  await act(async () => { fireEvent.keyDown(textarea, { key: 'Enter' }); context.resolve('Claude reference'); });
  assert.equal(getClaudeContext.mock.calls.length, 1);
  assert.deepEqual(bridge.piPrompt.mock.calls, [['/srv/local', 'session-a', '你怎么看', 'Claude reference', []]]);
  assert.equal(textarea.value, '下一条草稿');
  assert.ok(screen.getByText('你怎么看').closest('article'));

  await act(async () => { accepted.resolve(sessionView({ running: true, owner: 'pi', messages: [{ id: 'native-user', role: 'user', content: '你怎么看', timestamp: new Date().toISOString() }] })); });
  assert.equal(view.container.querySelectorAll('article').length, 1);
  assert.equal(screen.getAllByText('你怎么看').length, 1);
  assert.equal(textarea.value, '下一条草稿');
  assert.deepEqual(spies.onInputChange.mock.calls, [[''], ['下一条草稿']]);
});

test('Shift+Enter and IME confirmation do not submit Pi', async () => {
  const { spies } = await mount({ input: '中文输入' });
  const textarea = screen.getByRole('textbox', { name: 'Pi 输入' });
  await act(async () => {
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 229 });
  });
  assert.equal(spies.getClaudeContext.mock.calls.length, 0);
  assert.equal(spies.onInputChange.mock.calls.length, 0);
});

test('execution records show the actual command or file path', async () => {
  bridge.piGetSession.mockResolvedValue(sessionView({ events: [
    { seq: 1, type: 'tool_execution_start', data: { toolName: 'powershell', args: { command: 'Get-Content README.md' } } },
    { seq: 2, type: 'tool_execution_start', data: { toolName: 'read', args: { path: 'src/App.tsx' } } },
  ] }));
  await mount();
  assert.match(screen.getByText(/Get-Content README.md/).textContent || '', /powershell/);
  assert.match(screen.getByText(/src\/App.tsx/).textContent || '', /read/);
});

test('a text-only reply exposes zero tools after reload without claiming test execution', async () => {
  bridge.piGetSession.mockResolvedValue(sessionView({ lastResult: {
    status: 'completed', content: 'Claude previously reported 26/26', completedAt: '',
    toolCalls: 0, successfulToolCalls: 0, failedToolCalls: 0, stopReason: 'stop', workspaceStatus: 'released',
  } }));
  await mount();
  assert.ok(screen.getByText('执行记录 · 本轮未调用本地工具'));
  assert.equal(screen.queryByText(/测试通过|验收完成/), null);
});

test('execution evidence distinguishes successful, failed and interrupted calls', async () => {
  bridge.piGetSession.mockResolvedValue(sessionView({ lastResult: {
    status: 'aborted', content: '', completedAt: '', toolCalls: 3, successfulToolCalls: 1, failedToolCalls: 1,
    workspaceStatus: 'released',
  } }));
  await mount();
  assert.ok(screen.getByText('执行记录 · 本轮工具调用 3 次'));
  assert.ok(screen.getByText('成功 1 次，失败 1 次，未完成 1 次。'));
});

test('starting another turn does not present the previous turn evidence as new execution', async () => {
  const context = deferred<string>();
  bridge.piGetSession.mockResolvedValue(sessionView({ lastResult: {
    status: 'completed', content: 'previous', completedAt: '', toolCalls: 5, successfulToolCalls: 5, failedToolCalls: 0,
    workspaceStatus: 'released',
  } }));
  await mount({ input: 'new task', getClaudeContext: vi.fn().mockReturnValue(context.promise) });
  assert.ok(screen.getByText('执行记录 · 本轮工具调用 5 次'));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '发送' })); });
  assert.equal(screen.queryByText('执行记录 · 本轮工具调用 5 次'), null);
  await act(async () => { context.resolve('current reference'); });
  assert.equal(screen.queryByText('执行记录 · 本轮工具调用 5 次'), null);
});

test('unchanged-workspace release blocks button and Enter without claiming a file sync', async () => {
  bridge.piGetSession.mockResolvedValue(sessionView({ owner: 'pi', ownerSessionId: 'session-a', lastResult: {
    status: 'completed', content: 'answer', completedAt: '', toolCalls: 0, workspaceStatus: 'releasing',
  }, events: [{ seq: 1, type: 'workspace_handoff', data: { status: 'releasing' } }] }));
  const { spies } = await mount({ input: 'wait for release' });
  assert.equal((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled, true);
  assert.ok(screen.getByText('模型运行结束，正在交还工作区'));
  assert.equal(screen.queryByText(/正在同步并交还工作区/), null);
  await act(async () => { fireEvent.keyDown(screen.getByRole('textbox', { name: 'Pi 输入' }), { key: 'Enter' }); });
  assert.equal(bridge.piPrompt.mock.calls.length, 0);
  assert.equal(spies.getClaudeContext.mock.calls.length, 0);
  assert.deepEqual(spies.onOwnershipChange.mock.calls.at(-1), ['session-a', true]);
});

test('a failed context read preserves the submitted message and releases the project block without starting Pi',async()=>{
  const getClaudeContext=vi.fn().mockRejectedValue(new Error('Claude context could not be read'));
  const {spies}=await mount({input:'keep this task',getClaudeContext});
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'发送'}));});
  assert.equal(getClaudeContext.mock.calls.length,1);
  assert.equal(bridge.piPrompt.mock.calls.length,0);
  assert.equal((screen.getByRole('textbox',{name:'Pi 输入'}) as HTMLTextAreaElement).value,'');
  assert.ok(screen.getByText('keep this task').closest('article'));
  assert.deepEqual(spies.onInputChange.mock.calls,[['']]);
  assert.deepEqual(spies.onOwnershipChange.mock.calls.at(-1),['session-a',false]);
  assert.equal((screen.getByRole('button',{name:'发送'}) as HTMLButtonElement).disabled,true);
  assert.match(screen.getByRole('status').textContent || '',/Claude context could not be read/);
});

for (const transition of ['session-switch','unmount']) {
  test(`a delayed context read cannot start Pi after ${transition}`,async()=>{
    const context=deferred<string>();
    const getClaudeContext=vi.fn().mockReturnValue(context.promise);
    const {view,props,spies}=await mount({input:'old session task',getClaudeContext});
    await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'发送'}));});
    assert.equal(getClaudeContext.mock.calls.length,1);
    assert.equal(bridge.piPrompt.mock.calls.length,0);
    await act(async()=>{
      if(transition==='session-switch') view.rerender(<PiAgentPanel key="session-b" {...props} sessionId="session-b"/>);
      else view.unmount();
    });
    await act(async()=>{context.resolve('old session context');});
    assert.equal(bridge.piPrompt.mock.calls.length,0);
    assert.deepEqual(spies.onInputChange.mock.calls,[['']]);
    assert.equal(getClaudeContext.mock.calls.length,1);
  });
}

test('Claude becoming busy during the context read prevents Pi startup and preserves the submitted message',async()=>{
  const context=deferred<string>();
  const getClaudeContext=vi.fn().mockReturnValue(context.promise);
  const {view,props,spies}=await mount({input:'keep task during Claude run',getClaudeContext});
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'发送'}));});
  await act(async()=>{view.rerender(<PiAgentPanel key={props.sessionId} {...props} cloudBusy/>);});
  await act(async()=>{context.resolve('current context');});
  assert.equal(bridge.piPrompt.mock.calls.length,0);
  assert.deepEqual(spies.onInputChange.mock.calls,[['']]);
  assert.equal((screen.getByRole('textbox',{name:'Pi 输入'}) as HTMLTextAreaElement).value,'');
  assert.ok(screen.getByText('keep task during Claude run').closest('article'));
  assert.deepEqual(spies.onOwnershipChange.mock.calls.at(-1),['session-a',false]);
  assert.equal((screen.getByRole('button',{name:'发送'}) as HTMLButtonElement).disabled,true);
  assert.match(screen.getByRole('status').textContent || '',/Claude 已开始操作项目/);
});

test('cloud activity blocks concurrent Pi task without sending any native request',async()=>{
  const {spies}=await mount({input:'task',cloudBusy:true});
  assert.equal((screen.getByRole('button',{name:'发送'}) as HTMLButtonElement).disabled,true);
  await act(async()=>{fireEvent.submit(screen.getByRole('textbox',{name:'Pi 输入'}).closest('form')!);});
  assert.equal(bridge.piPrompt.mock.calls.length,0);
  assert.equal(spies.getClaudeContext.mock.calls.length,0);
});

test('settled Pi results display independently with no transfer or return buttons',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  const markdown='**EXACT RESULT**\n\n- Native build verified\n- GUI remains available\n\n```powershell\nWrite-Output "NATIVE_OK"\n```\n\n[C:/project/src/App.tsx:12](C:/project/src/App.tsx:12)';
  bridge.piGetSession.mockResolvedValue(sessionView({owner:'pi',running:true,runtimeActive:true,cursor:2}));
  bridge.piEvents.mockResolvedValue(sessionView({runtimeActive:true,cursor:3,messages:[
    {id:'empty-assistant',role:'assistant',content:' \n\t ',timestamp:'2026-10-04T00:00:00Z'},
    {id:'empty-user',role:'user',content:'\t ',timestamp:'2026-10-04T00:00:00Z'},
    {id:'a',role:'assistant',content:markdown,timestamp:'2026-10-04T00:00:00Z'},
  ],lastResult:{status:'completed',content:'hidden final metadata',changedFiles:['private-file'],completedAt:'2026-10-04T00:00:01Z'}}));
  const {view,spies}=await mount();
  await act(async()=>{await vi.advanceTimersByTimeAsync(500);});
  assert.deepEqual(spies.onOwnershipChange.mock.calls.at(-1),['session-a',false]);
  assert.equal(spies.getClaudeContext.mock.calls.length,0);
  assert.equal(screen.getByText('EXACT RESULT').tagName,'STRONG');
  assert.equal(view.container.querySelectorAll('article').length,1);
  assert.deepEqual([...screen.getAllByRole('listitem')].map((item)=>item.textContent),['Native build verified','GUI remains available']);
  assert.match(view.container.querySelector('article pre code')?.textContent || '',/Write-Output "NATIVE_OK"/);
  const windowsReference=screen.getByText('C:/project/src/App.tsx:12');
  assert.equal(windowsReference.closest('a'),null);
  fireEvent.click(windowsReference);
  assert.equal(openFileInEditor.mock.calls.length,0);
  assert.ok(screen.getByRole('button',{name:'停止 Pi 和本地程序'}));
  assert.equal(screen.queryByRole('button',{name:/转到 Claude|交还 Claude|发送给 Claude/}),null);
  assert.equal(bridge.piPrompt.mock.calls.length,0);
});

test('a persisted empty model failure survives reload and unchanged polling after workspace release', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const error = 'Pi 回复达到模型长度限制，未生成有效回复。';
  bridge.piGetSession.mockResolvedValue(sessionView({ cursor: 8, messagesReset: true, messages: [
    { id: 'request', role: 'user', content: 'install the plugin', timestamp: '2026-10-14T01:00:00Z' },
    { id: 'empty', role: 'assistant', content: '', timestamp: '2026-10-14T01:00:01Z' },
  ], lastResult: { status: 'error', content: '', error, completedAt: '2026-10-14T01:00:01Z', workspaceStatus: 'released' }, events: [] }));
  bridge.piEvents.mockResolvedValue(sessionView({ cursor: 8, messagesReset: false, lastResult: undefined, events: [] }));
  const first = await mount({ input: 'next task' });
  assert.match(screen.getByRole('alert').textContent || '', /Pi 运行失败/);
  assert.ok(screen.getByText(`Pi 运行失败：${error}`));
  assert.ok(screen.getByText('工作区已交还。'));
  assert.equal(first.view.container.querySelectorAll('article').length, 1);
  assert.equal(screen.queryByText('执行记录'), null);
  assert.equal((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled, false);
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  assert.ok(screen.getByText(`Pi 运行失败：${error}`));
  first.view.unmount();

  const reloaded = await mount();
  assert.ok(screen.getByText(`Pi 运行失败：${error}`));
  assert.ok(screen.getByText('工作区已交还。'));
  assert.equal(screen.queryByText('执行记录'), null);
  assert.equal(bridge.piPrompt.mock.calls.length, 0);
  assert.equal(first.spies.getClaudeContext.mock.calls.length, 0);
  assert.equal(reloaded.spies.getClaudeContext.mock.calls.length, 0);
});

test('a truncated Pi reply keeps its partial assistant text alongside the persisted model failure', async () => {
  const content = '**Partial reply** before the model length limit';
  bridge.piGetSession.mockResolvedValue(sessionView({ messages: [
    { id: 'partial', role: 'assistant', content, timestamp: '2026-10-14T01:00:01Z' },
  ], lastResult: { status: 'error', content, error: 'Pi 回复达到模型长度限制。', completedAt: '2026-10-14T01:00:01Z', workspaceStatus: 'released' } }));
  const { view } = await mount();
  assert.equal(screen.getByText('Partial reply').tagName, 'STRONG');
  assert.match(view.container.querySelector('article')?.textContent || '', /before the model length limit/);
  assert.equal(view.container.querySelectorAll('article').length, 1);
  assert.match(screen.getByRole('alert').textContent || '', /Pi 回复达到模型长度限制/);
  assert.ok(screen.getByText('工作区已交还。'));
});

test('model failure and workspace hand-back failure remain separate through successful recovery', async () => {
  const failed = { status: 'error' as const, content: '', error: 'model reply was truncated', completedAt: '2026-10-14T01:00:01Z', workspaceStatus: 'failed' as const, workspaceError: 'lease release failed' };
  bridge.piGetSession.mockResolvedValue(sessionView({ owner: 'pi', ownerSessionId: 'session-a', lastResult: failed }));
  await mount({ input: 'do not replay' });
  const alerts = screen.getAllByRole('alert');
  assert.equal(alerts.length, 2);
  assert.match(alerts[0].textContent || '', /Pi 运行失败：model reply was truncated/);
  assert.doesNotMatch(alerts[0].textContent || '', /lease release failed/);
  assert.match(alerts[1].textContent || '', /工作区交还失败：lease release failed/);
  assert.equal((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled, true);
  assert.equal(screen.queryByText('工作区已交还。'), null);
  bridge.piRecoverSession.mockResolvedValue(sessionView({ lastResult: { ...failed, workspaceStatus: 'released', workspaceError: undefined } }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重新交还工作区' })); });
  assert.equal(screen.getAllByRole('alert').length, 1);
  assert.match(screen.getByRole('alert').textContent || '', /Pi 运行失败：model reply was truncated/);
  assert.ok(screen.getByText('工作区已交还。'));
  assert.equal(screen.queryByRole('button', { name: '重新交还工作区' }), null);
  assert.equal(bridge.piPrompt.mock.calls.length, 0);
});

test('the single running stop button aborts Pi without submitting a task or reading Cloud context',async()=>{
  bridge.piGetSession.mockResolvedValue(sessionView({owner:'pi',running:true,runtimeActive:true,cursor:2}));
  const {spies}=await mount({input:'keep unsent Pi draft'});
  const buttons=screen.getAllByRole('button',{name:'停止 Pi 和本地程序'});
  assert.equal(buttons.length,1);
  assert.equal((buttons[0] as HTMLButtonElement).type,'button');
  await act(async()=>{fireEvent.click(buttons[0]);});
  assert.deepEqual(bridge.piAbort.mock.calls,[['/srv/local','session-a']]);
  assert.equal(bridge.piPrompt.mock.calls.length,0);
  assert.equal(spies.getClaudeContext.mock.calls.length,0);
  assert.equal(spies.onInputChange.mock.calls.length,0);
  assert.equal((screen.getByRole('textbox',{name:'Pi 输入'}) as HTMLTextAreaElement).value,'keep unsent Pi draft');
  assert.deepEqual(spies.onOwnershipChange.mock.calls.at(-1),['session-a',false]);
});

test('an in-flight poll cannot restore ownership after explicit stop',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  const owned=sessionView({owner:'pi',running:true,runtimeActive:true,cursor:2});
  bridge.piGetSession.mockResolvedValue(owned);
  const stale=deferred<PiSessionView>();bridge.piEvents.mockReturnValueOnce(stale.promise);
  const {spies}=await mount();
  await act(async()=>{await vi.advanceTimersByTimeAsync(500);});
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'停止 Pi 和本地程序'}));});
  await act(async()=>{stale.resolve(owned);});
  assert.deepEqual(spies.onOwnershipChange.mock.calls.at(-1),['session-a',false]);
  assert.equal(screen.queryByRole('button',{name:'停止 Pi 和本地程序'}),null);
  assert.equal(spies.getClaudeContext.mock.calls.length,0);
});

test('another session ownership and an unbound project cannot start or stop Pi',async()=>{
  bridge.piGetSession.mockResolvedValue(sessionView({owner:'pi',ownerSessionId:'other-session',runtimeActive:true}));
  const {view}=await mount({input:'task'});
  assert.equal((screen.getByRole('button',{name:'发送'}) as HTMLButtonElement).disabled,true);
  assert.equal(screen.queryByRole('button',{name:'停止 Pi 和本地程序'}),null);
  view.unmount();bridge.getState.mockResolvedValue({mappings:[]});
  const {spies}=await mount({input:'task'});
  assert.equal(screen.queryByRole('region',{name:'Pi 独立工作区'}),null);
  assert.deepEqual(spies.onEligibilityChange.mock.calls,[[false]]);
  assert.equal(bridge.piPrompt.mock.calls.length,0);
});

test('a failed initial ownership read remains explicitly unknown and can be manually refreshed', async () => {
  bridge.piGetSession.mockResolvedValueOnce({ ok: false, error: 'native status unavailable' });
  const { view, props, spies } = await mount();
  assert.deepEqual(spies.onOwnershipChange.mock.calls.at(-1), ['session-a', null, 'native status unavailable']);
  assert.match(screen.getByRole('status').textContent || '', /native status unavailable/);
  await act(async () => { view.rerender(<PiAgentPanel key={props.sessionId} {...props} refreshKey={1} />); });
  assert.deepEqual(spies.onOwnershipChange.mock.calls.at(-1), ['session-a', false]);
  assert.equal(screen.queryByText('native status unavailable'), null);
  assert.equal(bridge.piPrompt.mock.calls.length, 0);
});

test('failed workspace hand-back keeps ownership and only explicit recovery can release it', async () => {
  const finished = { status: 'completed' as const, content: 'model outcome', changedFiles: [], completedAt: '2026-10-06T01:00:00Z', workspaceStatus: 'failed' as const, workspaceError: 'sync failed' };
  bridge.piGetSession.mockResolvedValue(sessionView({ owner: 'pi', ownerSessionId: 'session-a', lastResult: finished }));
  const { spies } = await mount({ input: 'do not resend' });
  assert.match(screen.getByRole('alert').textContent || '', /sync failed/);
  assert.equal((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled, true);
  bridge.piRecoverSession.mockResolvedValueOnce({ ok: false, error: 'release still blocked' });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重新交还工作区' })); });
  assert.deepEqual(spies.onOwnershipChange.mock.calls.at(-1), ['session-a', true]);
  assert.ok(screen.getByRole('alert'));
  bridge.piRecoverSession.mockResolvedValueOnce(sessionView({ lastResult: { ...finished, workspaceStatus: 'released', workspaceError: undefined } }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重新交还工作区' })); });
  assert.deepEqual(spies.onOwnershipChange.mock.calls.at(-1), ['session-a', false]);
  assert.equal(screen.queryByRole('alert'), null);
  assert.equal(bridge.piPrompt.mock.calls.length, 0);
  assert.equal(spies.getClaudeContext.mock.calls.length, 0);
  assert.deepEqual(bridge.piRecoverSession.mock.calls, [['/srv/local', 'session-a'], ['/srv/local', 'session-a']]);
});

test('an unconfirmed stop keeps Pi ownership and never claims the runtime stopped', async () => {
  bridge.piGetSession.mockResolvedValue(sessionView({ owner: 'pi', running: true, runtimeActive: true }));
  bridge.piAbort.mockResolvedValue({ ok: false, error: 'process exit not confirmed' });
  const { spies } = await mount();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '停止 Pi 和本地程序' })); });
  assert.deepEqual(spies.onOwnershipChange.mock.calls.at(-1), ['session-a', true]);
  assert.ok(screen.getByRole('button', { name: '停止 Pi 和本地程序' }));
  assert.match(screen.getByRole('status').textContent || '', /process exit not confirmed/);
});

test('a failed stop applies the native stopped-but-unreleased snapshot and offers recovery', async () => {
  bridge.piGetSession.mockResolvedValue(sessionView({ owner: 'pi', running: true, runtimeActive: true }));
  bridge.piAbort.mockResolvedValue(sessionView({ ok: false, error: 'lease release failed', owner: 'pi',
    ownerSessionId: 'session-a', running: false, runtimeActive: false,
    lastResult: { status: 'aborted', content: '', completedAt: '', workspaceStatus: 'failed', workspaceError: 'lease release failed' },
  }));
  const { spies } = await mount({ input: 'retain draft' });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '停止 Pi 和本地程序' })); });
  assert.deepEqual(spies.onOwnershipChange.mock.calls.at(-1), ['session-a', true]);
  assert.equal(screen.queryByRole('button', { name: '停止 Pi 和本地程序' }), null);
  assert.ok(screen.getByRole('button', { name: '重新交还工作区' }));
  assert.equal((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled, true);
  assert.equal(screen.queryByText('已停止 Pi 和本地程序。'), null);
});

test('failed preparation with an unconfirmed hand-back applies its authoritative blocked snapshot immediately', async () => {
  bridge.piPrompt.mockResolvedValue(sessionView({ ok: false, error: 'prepare release failed', owner: 'pi', ownerSessionId: 'session-a', lastResult: { status: 'error', content: '', completedAt: '2026-10-06T01:00:00Z', workspaceStatus: 'failed', workspaceError: 'prepare release failed' } }));
  const { spies } = await mount({ input: 'prepare without replay' });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '发送' })); });
  assert.deepEqual(spies.onOwnershipChange.mock.calls.at(-1), ['session-a', true]);
  const alerts = screen.getAllByRole('alert');
  assert.equal(alerts.length, 2);
  assert.match(alerts[0].textContent || '', /Pi 运行失败/);
  assert.match(alerts[1].textContent || '', /工作区交还失败：prepare release failed/);
  assert.ok(screen.getByRole('button', { name: '重新交还工作区' }));
  assert.equal(bridge.piPrompt.mock.calls.length, 1);
});

function notifySync(status: string, serverPath = '/srv/local') {
  notifications.sync.forEach(listener => listener({ serverPath, status, checkedAt: '', bindingEpoch: '', sequence: 1 }));
}

test('an unbound poll confirms mapping removal, releases the cloud block and stops polling', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const { spies } = await mount();
  bridge.getState.mockResolvedValue({ mappings: [], inactiveMappings: [] });
  bridge.piEvents.mockResolvedValue({ ok: false, code: 'UNBOUND_WORKSPACE', error: '项目尚未绑定本地目录' });
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  assert.deepEqual(spies.onEligibilityChange.mock.calls.at(-1), [false]);
  assert.deepEqual(spies.onOwnershipChange.mock.calls.at(-1), ['session-a', false]);
  assert.equal(screen.queryByRole('region', { name: 'Pi 独立工作区' }), null);
  assert.equal(bridge.getState.mock.calls.length, 2);
  assert.equal(bridge.piEvents.mock.calls.length, 1);
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  assert.equal(bridge.piEvents.mock.calls.length, 1);
});

for (const active of [true, false]) {
  test(`an unbound connection reply does not release a retained ${active ? 'active' : 'inactive'} mapping`, async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    bridge.piGetSession.mockResolvedValueOnce(sessionView({ owner: 'pi', running: true }));
    const { spies } = await mount();
    spies.onOwnershipChange.mockClear();
    const mapping = { serverPath: '/srv/local', localPath: 'C:\\project' };
    bridge.getState.mockResolvedValue({ mappings: active ? [mapping] : [], inactiveMappings: active ? [] : [mapping] });
    bridge.piEvents.mockResolvedValue({ ok: false, code: 'UNBOUND_WORKSPACE', error: '当前账号未连接此本地工作区' });
    bridge.piGetSession.mockResolvedValue({ ok: false, code: 'UNBOUND_WORKSPACE', error: '当前账号未连接此本地工作区' });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    assert.equal(spies.onOwnershipChange.mock.calls.at(-1)?.[1], null);
    assert.equal(spies.onOwnershipChange.mock.calls.some(call => call[1] === false), false);
    assert.deepEqual(spies.onEligibilityChange.mock.calls.at(-1), [active]);
  });
}

test('a mapping event removes hidden Pi eligibility before a late owned poll can reblock cloud sending', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const owned = sessionView({ owner: 'pi', running: true, runtimeActive: true });
  bridge.piGetSession.mockResolvedValue(owned);
  const stale = deferred<PiSessionView>();
  bridge.piEvents.mockReturnValue(stale.promise);
  const { spies } = await mount();
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  assert.equal(bridge.piEvents.mock.calls.length, 1);
  await act(async () => { notifySync('unbound', '/srv/unrelated'); });
  assert.equal(bridge.getState.mock.calls.length, 1);
  bridge.getState.mockResolvedValue({ mappings: [], inactiveMappings: [] });
  await act(async () => { notifySync('unbound'); });
  assert.deepEqual(spies.onOwnershipChange.mock.calls.at(-1), ['session-a', false]);
  assert.deepEqual(spies.onEligibilityChange.mock.calls.at(-1), [false]);
  const updatesAfterRemoval = spies.onOwnershipChange.mock.calls.length;
  await act(async () => { stale.resolve(owned); await vi.advanceTimersByTimeAsync(5000); });
  assert.equal(spies.onOwnershipChange.mock.calls.length, updatesAfterRemoval);
  assert.equal(bridge.piEvents.mock.calls.length, 1);
  assert.equal(screen.queryByRole('region', { name: 'Pi 独立工作区' }), null);
});

test('a workspace connection event restores Pi eligibility from the current mapping snapshot', async () => {
  bridge.getState.mockResolvedValue({ mappings: [], inactiveMappings: [] });
  const { spies } = await mount();
  assert.equal(screen.queryByRole('region', { name: 'Pi 独立工作区' }), null);
  assert.equal(bridge.piGetSession.mock.calls.length, 0);
  bridge.getState.mockResolvedValue({ mappings: [{ serverPath: '/srv/local', localPath: 'C:\\project' }], inactiveMappings: [] });
  await act(async () => { notifications.connection.forEach(listener => listener()); });
  assert.ok(screen.getByRole('region', { name: 'Pi 独立工作区' }));
  assert.deepEqual(spies.onEligibilityChange.mock.calls.at(-1), [true]);
  assert.deepEqual(spies.onOwnershipChange.mock.calls.at(-1), ['session-a', false]);
  assert.deepEqual(bridge.piGetSession.mock.calls, [['/srv/local', 'session-a']]);
});

for (const operation of ['context', 'prompt', 'stop', 'recover'] as const) {
  test(`mapping removal invalidates a late ${operation} operation without changing the confirmed release`, async () => {
    const pending = deferred<unknown>();
    const initial = operation === 'stop' ? sessionView({ owner: 'pi', running: true, runtimeActive: true })
      : operation === 'recover' ? sessionView({ owner: 'pi', lastResult: { status: 'completed', content: 'done', completedAt: '', workspaceStatus: 'failed', workspaceError: 'retry release' } })
        : sessionView();
    bridge.piGetSession.mockResolvedValue(initial);
    if (operation === 'prompt') bridge.piPrompt.mockReturnValue(pending.promise);
    if (operation === 'stop') bridge.piAbort.mockReturnValue(pending.promise);
    if (operation === 'recover') bridge.piRecoverSession.mockReturnValue(pending.promise);
    const getClaudeContext = operation === 'context' ? vi.fn().mockReturnValue(pending.promise) : vi.fn().mockResolvedValue('reference');
    const { spies } = await mount({ input: 'original task', getClaudeContext });
    const action = operation === 'stop' ? '停止 Pi 和本地程序' : operation === 'recover' ? '重新交还工作区' : '发送';
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: action })); });
    if (operation === 'context') assert.equal(getClaudeContext.mock.calls.length, 1);
    if (operation === 'prompt') assert.equal(bridge.piPrompt.mock.calls.length, 1);
    bridge.getState.mockResolvedValue({ mappings: [], inactiveMappings: [] });
    await act(async () => { notifySync('unbound'); });
    assert.deepEqual(spies.onOwnershipChange.mock.calls.at(-1), ['session-a', false]);
    const updatesAfterRemoval = spies.onOwnershipChange.mock.calls.length;
    await act(async () => { pending.resolve(operation === 'context' ? 'late reference' : operation === 'stop' ? { ok: true } : sessionView({ owner: 'pi', running: true })); });
    assert.equal(spies.onOwnershipChange.mock.calls.length, updatesAfterRemoval);
    assert.equal(screen.queryByRole('region', { name: 'Pi 独立工作区' }), null);
    if (operation === 'context') assert.equal(bridge.piPrompt.mock.calls.length, 0);
  });
}

test('saving from general settings updates the already mounted composer model picker', async () => {
  await mount();
  await act(async () => { render(<PiAgentSettings />); });
  const settings = within(screen.getByRole('region', { name: '本地 Pi 设置' }));
  fireEvent.change(settings.getByLabelText('模型'), { target: { value: 'general-settings-model' } });
  await act(async () => { fireEvent.click(settings.getByRole('button', { name: '保存模型配置' })); });
  const trigger = screen.getByRole('button', { name: 'Pi 选择模型' });
  assert.equal(trigger.textContent?.trim(), 'general-settings-model');
  fireEvent.click(trigger);
  assert.equal(screen.getByRole('menuitemradio', { name: 'general-settings-model' }).getAttribute('aria-checked'), 'true');
});

test('a saved notification outranks both late initial configuration reads', async () => {
  const menuRead = deferred<PiConfigView>();
  const settingsRead = deferred<PiConfigView>();
  bridge.piGetConfig.mockReturnValueOnce(menuRead.promise).mockReturnValueOnce(settingsRead.promise);
  await mount();
  await act(async () => { render(<PiAgentSettings />); });
  const next = { ...config, model: 'new-authoritative-model' };
  await act(async () => { notifications.config.forEach(listener => listener(next)); });
  assert.equal(screen.getByRole('button', { name: 'Pi 选择模型' }).textContent?.trim(), 'new-authoritative-model');
  assert.equal((screen.getByLabelText('模型') as HTMLInputElement).value, 'new-authoritative-model');
  await act(async () => { menuRead.resolve(config); settingsRead.resolve(config); });
  assert.equal(screen.getByRole('button', { name: 'Pi 选择模型' }).textContent?.trim(), 'new-authoritative-model');
  assert.equal((screen.getByLabelText('模型') as HTMLInputElement).value, 'new-authoritative-model');
});

test('a composer configuration save preserves the unsaved draft in general settings', async () => {
  await mount();
  await act(async () => { render(<PiAgentSettings />); });
  const general = within(screen.getByRole('region', { name: '本地 Pi 设置' }));
  fireEvent.change(general.getByLabelText('模型'), { target: { value: 'unsaved-general-model' } });
  fireEvent.change(general.getByLabelText('API Key'), { target: { value: 'synthetic-general-draft-key' } });
  fireEvent.click(screen.getByRole('button', { name: 'Pi 选择模型' }));
  await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: '配置自定义模型' })); });
  const popup = within(screen.getByRole('dialog', { name: 'Pi 自定义模型配置' }));
  fireEvent.change(popup.getByLabelText('模型'), { target: { value: 'saved-composer-model' } });
  await act(async () => { fireEvent.click(popup.getByRole('button', { name: '保存模型配置' })); });
  assert.equal(screen.getByRole('button', { name: 'Pi 选择模型' }).textContent?.trim(), 'saved-composer-model');
  assert.equal((general.getByLabelText('模型') as HTMLInputElement).value, 'unsaved-general-model');
  assert.equal((general.getByLabelText('API Key') as HTMLInputElement).value, 'synthetic-general-draft-key');
  assert.equal((popup.getByLabelText('模型') as HTMLInputElement).value, 'saved-composer-model');
});

for (const continueEditing of [false, true]) {
  test(`Pi installation preserves ${continueEditing ? 'continued edits to' : 'all fields of'} an unsaved first configuration`, async () => {
    const empty = { ...config, installed: false, configured: false, hasApiKey: false, model: '', baseUrl: '' };
    bridge.piGetConfig.mockResolvedValue(empty);
    await act(async () => { render(<PiAgentSettings />); });
    fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'first-draft-model' } });
    fireEvent.change(screen.getByLabelText('API 地址'), { target: { value: 'https://draft.example.test/v1' } });
    fireEvent.change(screen.getByLabelText('API 协议'), { target: { value: 'openai-responses' } });
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'synthetic-first-draft-key' } });
    const installed = deferred<{ ok: boolean }>();
    bridge.piInstall.mockReturnValue(installed.promise);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '安装 Pi' })); });
    if (continueEditing) {
      fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'continued-draft-model' } });
      fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'synthetic-continued-draft-key' } });
    }
    bridge.piGetConfig.mockResolvedValue({ ...empty, installed: true });
    await act(async () => { installed.resolve({ ok: true }); });
    assert.equal((screen.getByLabelText('模型') as HTMLInputElement).value, continueEditing ? 'continued-draft-model' : 'first-draft-model');
    assert.equal((screen.getByLabelText('API 地址') as HTMLInputElement).value, 'https://draft.example.test/v1');
    assert.equal((screen.getByLabelText('API 协议') as HTMLSelectElement).value, 'openai-responses');
    assert.equal((screen.getByLabelText('API Key') as HTMLInputElement).value, continueEditing ? 'synthetic-continued-draft-key' : 'synthetic-first-draft-key');
    assert.ok(screen.getByText('已安装 1.0.2 · 需要配置模型'));
    assert.equal(bridge.piSaveConfig.mock.calls.length, 0);
  });
}

test('save completion does not clear the model and key edited after submission', async () => {
  await act(async () => { render(<PiAgentSettings />); });
  fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'submitted-model' } });
  fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'synthetic-submitted-key' } });
  const saved = deferred<PiConfigView>();
  bridge.piSaveConfig.mockReturnValue(saved.promise);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存模型配置' })); });
  assert.equal(bridge.piSaveConfig.mock.calls[0][0].model, 'submitted-model');
  assert.equal(bridge.piSaveConfig.mock.calls[0][0].apiKey, 'synthetic-submitted-key');
  fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'next-draft-model' } });
  fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'synthetic-next-draft-key' } });
  await act(async () => { saved.resolve({ ...config, model: 'submitted-model' }); });
  assert.equal((screen.getByLabelText('模型') as HTMLInputElement).value, 'next-draft-model');
  assert.equal((screen.getByLabelText('API Key') as HTMLInputElement).value, 'synthetic-next-draft-key');
  assert.match(screen.getByRole('status').textContent || '', /配置已保存/);
});

test('a late initial settings read leaves a draft entered before it returned intact', async () => {
  const initial = deferred<PiConfigView>();
  bridge.piGetConfig.mockReturnValue(initial.promise);
  await act(async () => { render(<PiAgentSettings />); });
  fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'early-draft-model' } });
  fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'synthetic-early-draft-key' } });
  await act(async () => { initial.resolve(config); });
  assert.equal((screen.getByLabelText('模型') as HTMLInputElement).value, 'early-draft-model');
  assert.equal((screen.getByLabelText('API Key') as HTMLInputElement).value, 'synthetic-early-draft-key');
});
