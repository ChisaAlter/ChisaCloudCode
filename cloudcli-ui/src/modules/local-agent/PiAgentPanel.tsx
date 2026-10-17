import { useEffect, useMemo, useRef, useState } from 'react';
import { BotIcon, FileIcon, Loader2, PlusIcon, SquareIcon, XIcon } from 'lucide-react';

import { FrontendBridge, onWorkspaceConnectionChanged, onWorkspaceSyncStateChanged } from '@/shared/chisa';
import { Markdown } from '@/modules/chat';
import { Button, PromptInput, PromptInputHeader, PromptInputBody, PromptInputTextarea, PromptInputFooter, PromptInputTools, PromptInputButton, PromptInputSubmit } from '@/shared/ui';
import type { PiAgentEvent, PiAttachmentInput, PiMessage, PiSessionView } from '@/shared/types';
import { PiModelMenu } from '@/modules/local-agent/PiModelMenu';

type PiAgentPanelProps = {
  serverPath: string;
  sessionId: string;
  isActive: boolean;
  cloudBusy: boolean;
  input: string;
  onInputChange: (text: string) => void;
  getClaudeContext: () => Promise<string>;
  onOwnershipChange: (sessionId: string, blocked: boolean | null, error?: string) => void;
  onEligibilityChange: (eligible: boolean) => void;
  onClose: () => void;
  refreshKey?: number;
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

const MAX_ATTACHMENT_COUNT = 10;
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;

function filePayload(file: File): Promise<PiAttachmentInput> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`无法读取附件：${file.name}`));
    reader.onload = () => {
      const dataUrl = String(reader.result);
      resolve({ name: file.name, mimeType: file.type, dataBase64: dataUrl.slice(dataUrl.indexOf(',') + 1) });
    };
    reader.readAsDataURL(file);
  });
}

function eventDisplay(event: PiAgentEvent): string | undefined {
  const data = object(event.data);
  const type = typeof data.type === 'string' ? data.type : event.type;
  if (type === 'tool_execution_start') {
    const args = object(data.args);
    const detail = args.command || args.path || args.filePath;
    return `正在执行：${String(data.toolName || '本地工具')}${typeof detail === 'string' ? ` — ${detail}` : ''}`;
  }
  if (type === 'tool_execution_end') return `${data.isError ? '工具失败' : '工具完成'}：${String(data.toolName || '本地工具')}`;
  if (type === 'error' || type === 'agent_error') {
    const nested = object(data.error);
    return `Pi 错误：${typeof data.message === 'string' ? data.message : typeof data.error === 'string' ? data.error : typeof nested.message === 'string' ? nested.message : '本地运行失败'}`;
  }
  if (type === 'agent_settled') return '本轮运行已结束';
  if (type === 'context_externalized') return '旧版重复的 Claude 上下文已整理为参考文件，Pi 对话和工具记录已保留';
  if (type === 'workspace_handoff') {
    return data.status === 'failed' ? `工作区交还失败：${String(data.error || '尚未确认')}`
      : data.status === 'released' ? '工作区已交还' : data.status === 'syncing' ? '文件有改动或尚未确认，正在同步并交还工作区' : '模型运行结束，正在交还工作区';
  }
  return undefined;
}

/** ChatInterface renders this private right workspace; its history and events never enter the cloud conversation. */
export function PiAgentPanel({ serverPath, sessionId, isActive, cloudBusy, input, onInputChange, getClaudeContext, onOwnershipChange, onEligibilityChange, onClose, refreshKey = 0 }: PiAgentPanelProps) {
  // Native history is authoritative and restores independently of Claude's transcript.
  const [session, setSession] = useState<PiSessionView | null>(null);
  // Display submitted turns while context loading precedes native acceptance;
  // a failed submission stays visible alongside its error.
  const [pendingMessages, setPendingMessages] = useState<PiMessage[]>([]);
  // Selected files belong to the next Pi turn, independently of Claude attachments.
  const [attachments, setAttachments] = useState<File[]>([]);
  // Only a bound desktop project can use the Windows process.
  const [eligible, setEligible] = useState(false);
  // Serialize user requests with native state updates.
  const [busy, setBusy] = useState(false);
  // Progress is private to the right workspace, including after the user closes it.
  const [progress, setProgress] = useState<string[]>([]);
  // Native operation failures remain visible only to the user.
  const [note, setNote] = useState('');
  const alive = useRef(true);
  const nativeOperation = useRef(false);
  const operationRevision = useRef(0);
  const messagesPane = useRef<HTMLDivElement>(null);
  const attachmentPicker = useRef<HTMLInputElement>(null);
  const callbacks = useRef({ onInputChange, onOwnershipChange, onEligibilityChange, cloudBusy });
  callbacks.current = { onInputChange, onOwnershipChange, onEligibilityChange, cloudBusy };

  useEffect(() => {
    if (messagesPane.current) messagesPane.current.scrollTop = messagesPane.current.scrollHeight;
  }, [pendingMessages.length, session?.messages.length]);

  useEffect(() => {
    alive.current = true;
    let stopped = false;
    let bound = false;
    let bindingRevision = 0;
    let cursor = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    callbacks.current.onOwnershipChange(sessionId, null);
    const apply = (view: PiSessionView) => {
      setSession((previous) => {
        if (view.messagesReset !== false || !previous) return view;
        if (previous.cursor === view.cursor && previous.owner === view.owner
          && previous.ownerSessionId === view.ownerSessionId && previous.running === view.running
          && previous.runtimeActive === view.runtimeActive && view.lastResult === undefined) return previous;
        const updates = new Map(view.messages.map((message) => [message.id, message]));
        const messages = previous.messages.map((message) => {
          const replacement = updates.get(message.id);
          updates.delete(message.id);
          return replacement ?? message;
        });
        messages.push(...updates.values());
        return { ...previous, ...view, messages };
      });
      callbacks.current.onOwnershipChange(sessionId, view.owner === 'pi');
      cursor = view.cursor;
      if (view.events?.length) setProgress((previous) => {
        const activity = [...previous];
        for (const event of view.events || []) {
          const display = eventDisplay(event);
          if (display) activity.push(display);
        }
        return activity.slice(-12);
      });
    };
    const schedulePoll = (delay: number) => {
      if (stopped || !bound) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void poll(), delay);
    };
    const fail = (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      setNote(message);
      callbacks.current.onOwnershipChange(sessionId, null, message);
    };
    async function poll() {
      if (stopped || !bound) return;
      const binding = bindingRevision;
      const revision = operationRevision.current;
      let delay = 1500;
      try {
        const view = await FrontendBridge.piEvents(serverPath, sessionId, cursor);
        if (stopped || binding !== bindingRevision) return;
        if (!nativeOperation.current && revision === operationRevision.current) {
          if (!view.ok) {
            if (object(view).code === 'UNBOUND_WORKSPACE') {
              await refreshBinding();
              return;
            }
            throw new Error(view.error || '读取 Pi 状态失败');
          }
          apply(view);
        }
        if (view.running && isActive) delay = 500;
      } catch (error) {
        if (!stopped && binding === bindingRevision && !nativeOperation.current && revision === operationRevision.current) fail(error);
      }
      if (binding === bindingRevision) schedulePoll(delay);
    }
    async function refreshBinding() {
      const binding = ++bindingRevision;
      const revision = operationRevision.current;
      if (timer) clearTimeout(timer);
      try {
        const state = await FrontendBridge.getState();
        if (stopped || binding !== bindingRevision) return;
        bound = state.mappings.some((mapping) => mapping.serverPath === serverPath);
        setEligible(bound);
        callbacks.current.onEligibilityChange(bound);
        if (!bound) {
          // Missing active transport is not proof that a retained local binding is gone.
          operationRevision.current++;
          if (state.inactiveMappings?.some(mapping => mapping.serverPath === serverPath)) {
            fail(new Error('本地工作区连接尚未确认，请恢复连接后检查 Pi 状态。'));
          } else {
            cursor = 0;
            setSession(null);
            setProgress([]);
            setNote('');
            callbacks.current.onOwnershipChange(sessionId, false);
          }
          return;
        }
        if (nativeOperation.current || revision !== operationRevision.current) {
          schedulePoll(1500);
          return;
        }
        const view = await FrontendBridge.piGetSession(serverPath, sessionId);
        if (stopped || binding !== bindingRevision) return;
        if (!nativeOperation.current && revision === operationRevision.current) {
          if (!view.ok) throw new Error(view.error || '读取 Pi 会话失败');
          apply(view);
          setNote('');
        }
        schedulePoll(view.running && isActive ? 500 : 1500);
      } catch (error) {
        if (stopped || binding !== bindingRevision) return;
        if (!nativeOperation.current && revision === operationRevision.current) fail(error);
        schedulePoll(1500);
      }
    }
    const unsubscribeSync = onWorkspaceSyncStateChanged(info => {
      if (info.serverPath === serverPath) void refreshBinding();
    });
    const unsubscribeConnection = onWorkspaceConnectionChanged(() => { void refreshBinding(); });
    void refreshBinding();
    return () => {
      stopped = true;
      alive.current = false;
      if (timer) clearTimeout(timer);
      unsubscribeSync();
      unsubscribeConnection();
    };
  }, [isActive, serverPath, sessionId, refreshKey]);

  const prompt = async () => {
    if ((!input.trim() && attachments.length === 0) || !session || nativeOperation.current || busy || session.running || session.lastResult?.workspaceStatus === 'failed' || session.lastResult?.workspaceStatus === 'syncing' || session.lastResult?.workspaceStatus === 'releasing') return;
    if (session?.owner === 'pi' && session.ownerSessionId && session.ownerSessionId !== sessionId) { setNote('此项目正在另一个 Pi 工作区执行任务。'); return; }
    if (cloudBusy) { setNote('Claude 正在操作同一项目，请等本轮结束后再发送给 Pi。'); return; }
    const task = input.trim() || '请查看附件。';
    const submittedFiles = attachments;
    const pendingId = crypto.randomUUID();
    const previouslyOwned = session?.owner === 'pi';
    nativeOperation.current = true;
    const revision = ++operationRevision.current;
    const current = () => alive.current && revision === operationRevision.current;
    callbacks.current.onOwnershipChange(sessionId, true);
    setBusy(true);
    setNote('');
    setPendingMessages((previous) => [...previous, { id: pendingId, role: 'user', content: task, timestamp: new Date().toISOString(), attachments: submittedFiles.map((file) => ({ name: file.name, mimeType: file.type, size: file.size })) }]);
    callbacks.current.onInputChange('');
    setAttachments([]);
    setProgress(['正在读取当前 Claude 对话…']);
    let prompted = false;
    let confirmedOwnership: boolean | undefined;
    try {
      const payloads = await Promise.all(submittedFiles.map(filePayload));
      if (!current()) return;
      const context = await getClaudeContext();
      // Switching sessions unmounts this panel; an old history response must
      // never start a task against its previous project or conversation.
      if (!current()) return;
      if (callbacks.current.cloudBusy) throw new Error('Claude 已开始操作项目，请等本轮结束后再发送。');
      setProgress(['Claude 上下文已读取，正在启动 Pi…']);
      const result = await FrontendBridge.piPrompt(serverPath, sessionId, task, context, payloads);
      if (current() && (result.owner === 'pi' || result.owner === 'claude')) {
        setSession(result);
        confirmedOwnership = result.owner === 'pi';
        callbacks.current.onOwnershipChange(sessionId, confirmedOwnership);
      }
      if (!result.ok) throw new Error(result.error || 'Pi 尚未开始运行');
      prompted = true;
      if (!current()) return;
      setSession(result);
      setPendingMessages((previous) => previous.filter((message) => message.id !== pendingId));
      setNote('');
      setProgress(['Pi 正在执行任务']);
    } catch (error) {
      if (current()) {
        callbacks.current.onOwnershipChange(sessionId, confirmedOwnership ?? (previouslyOwned || prompted));
        setProgress([]);
        setNote(error instanceof Error ? error.message : String(error));
        if (!prompted) setAttachments((current) => [...submittedFiles, ...current]);
      }
    } finally {
      nativeOperation.current = false;
      operationRevision.current++;
      if (alive.current) setBusy(false);
    }
  };

  const stop = async () => {
    if (nativeOperation.current) return;
    nativeOperation.current = true;
    const revision = ++operationRevision.current;
    const current = () => alive.current && revision === operationRevision.current;
    setBusy(true);
    try {
      const result = await FrontendBridge.piAbort(serverPath, sessionId);
      if (!current()) return;
      if (result.owner === 'pi' || result.owner === 'claude') {
        setSession(result);
        callbacks.current.onOwnershipChange(sessionId, result.owner === 'pi');
      }
      if (!result.ok) throw new Error(result.error || 'Pi 停止未确认');
      setNote(result.owner === 'pi' ? 'Pi 和本地程序已停止，工作区尚未交还。' : '已停止 Pi 和本地程序。');
    } catch (error) { if (current()) setNote(error instanceof Error ? error.message : String(error)); }
    finally { nativeOperation.current = false; operationRevision.current++; if (alive.current) setBusy(false); }
  };

  const recoverWorkspace = async () => {
    if (nativeOperation.current || !session || session.running || session.owner !== 'pi') return;
    nativeOperation.current = true;
    const revision = ++operationRevision.current;
    const current = () => alive.current && revision === operationRevision.current;
    setBusy(true);
    setNote('');
    try {
      const result = await FrontendBridge.piRecoverSession(serverPath, sessionId);
      if (!current()) return;
      if (result.owner === 'pi' || result.owner === 'claude') {
        setSession(result);
        callbacks.current.onOwnershipChange(sessionId, result.owner === 'pi');
      }
      if (!result.ok) throw new Error(result.error || '工作区交还仍未确认');
      setNote('工作区已交还，没有重新运行 Pi 任务。');
    } catch (error) {
      if (current()) setNote(error instanceof Error ? error.message : String(error));
    } finally {
      nativeOperation.current = false;
      operationRevision.current++;
      if (alive.current) setBusy(false);
    }
  };

  const messages = useMemo(() => [...(session?.messages || []), ...pendingMessages]
    .filter((message) => message.content.trim()).sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)),
  [session?.messages, pendingMessages]);
  if (!eligible) return null;
  const ownedByOtherSession = session?.owner === 'pi' && Boolean(session.ownerSessionId && session.ownerSessionId !== sessionId);
  const handback = session?.lastResult?.workspaceStatus;
  const handingBack = handback === 'releasing' || handback === 'syncing';
  const turnEvidence = !busy && !session?.running ? session?.lastResult : undefined;
  const unfinishedToolCalls = Math.max(0, (turnEvidence?.toolCalls ?? 0) - (turnEvidence?.successfulToolCalls ?? 0) - (turnEvidence?.failedToolCalls ?? 0));
  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col bg-background text-sm" aria-label="Pi 独立工作区">
      <header className="chat-session-tools flex h-8 shrink-0 items-center gap-2 px-4">
        <h2 className="shrink-0 text-sm font-medium">Pi</h2>
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title="Pi 可按需读取当前 Claude 对话正文和工具结果；Pi 的对话与结果不会回传给 Claude。">{ownedByOtherSession ? '其他工作区正在执行' : busy ? '正在处理请求' : !session ? '状态尚未确认' : session.running ? '正在执行' : handingBack ? '正在交还工作区' : handback === 'failed' ? '工作区交还未确认' : '可读取 Claude 上下文'}</p>
        <Button type="button" variant="ghost" size="icon" onClick={onClose} className="h-7 w-7 shrink-0 rounded-lg text-muted-foreground" aria-label="关闭 Pi 工作区" title="关闭 Pi 工作区"><XIcon className="h-3.5 w-3.5" /></Button>
      </header>
      <div ref={messagesPane} className="chat-messages-pane min-h-0 min-w-0 flex-1 space-y-6 overflow-y-auto overflow-x-hidden px-4 py-4">
        {messages.length === 0 && <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-center text-muted-foreground"><BotIcon className="h-8 w-8 text-primary/70" /><p className="font-medium text-foreground">继续你的项目</p><p className="max-w-xs text-xs leading-5">Pi 可以读取当前 Claude 对话，并在 Windows 中操作项目。结果保留在这里。</p></div>}
        {messages.map((message) => (
          <article key={message.id} className={message.role === 'user' ? 'flex min-w-0 justify-end' : 'min-w-0'}>
            {message.role === 'user' ? (
              <div className="max-w-[90%] rounded-2xl rounded-br-md border border-border/60 bg-muted/60 px-4 py-2 text-foreground shadow-sm">
                <Markdown breaks disableFileLinks className="prose prose-sm max-w-none break-words font-serif dark:prose-invert">{message.content}</Markdown>
                {message.attachments?.map((file, index) => <div key={`${index}-${file.name}`} className="mt-2 flex min-w-0 items-center gap-2 text-xs"><FileIcon className="h-4 w-4 shrink-0" /><span className="truncate" title={file.name}>{file.name}</span></div>)}
                <div className="mt-1 text-right text-xs text-muted-foreground">{new Date(message.timestamp).toLocaleTimeString()}</div>
              </div>
            ) : (
              <>
                <div className="mb-2 flex items-center gap-3"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><BotIcon className="h-5 w-5" /></span><span className="font-medium">Pi</span></div>
                <Markdown disableFileLinks className="prose prose-sm max-w-none break-words font-serif dark:prose-invert">{message.content}</Markdown>
                <div className="mt-2 text-[11px] text-muted-foreground">{new Date(message.timestamp).toLocaleTimeString()}</div>
              </>
            )}
          </article>
        ))}
        {(progress.length > 0 || turnEvidence?.toolCalls !== undefined) && <details className="rounded-lg border-l-2 border-border pl-3 text-xs text-muted-foreground" open={busy || session?.running}>
          <summary className="cursor-pointer">执行记录{turnEvidence?.toolCalls === undefined ? '' : turnEvidence.toolCalls === 0 ? ' · 本轮未调用本地工具' : ` · 本轮工具调用 ${turnEvidence.toolCalls} 次`}</summary>
          {turnEvidence?.toolCalls !== undefined && turnEvidence.toolCalls > 0 && <p className="mt-2">成功 {turnEvidence.successfulToolCalls ?? 0} 次，失败 {turnEvidence.failedToolCalls ?? 0} 次{unfinishedToolCalls > 0 ? `，未完成 ${unfinishedToolCalls} 次` : ''}。</p>}
          {progress.map((line, index) => <p key={`${index}-${line}`} className="mt-2 whitespace-pre-wrap break-words">{line}</p>)}
        </details>}
        {note && <p role="status" className="text-xs text-muted-foreground">{note}</p>}
        {session?.lastResult?.status === 'error' && <div role="alert" className="space-y-1 text-xs">
          <p className="whitespace-pre-wrap break-words text-destructive">Pi 运行失败：{session.lastResult.error || '本地运行失败'}</p>
          {handback === 'released' && <p className="text-muted-foreground">工作区已交还。</p>}
        </div>}
        {handback === 'failed' && <div role="alert" className="space-y-2 rounded-lg border border-border p-3 text-xs">
          <p>模型运行已结束，但工作区交还失败：{session?.lastResult?.workspaceError || '文件同步或租约释放尚未确认'}。不要重发原任务。</p>
          {!ownedByOtherSession && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void recoverWorkspace()}>重新交还工作区</Button>}
        </div>}
      </div>
      <div className="chat-composer-shell relative shrink-0 px-2 pb-2 pt-0 sm:px-4 sm:pb-4 md:pb-6">
        {cloudBusy && <p className="mb-2 px-2 text-xs text-muted-foreground">Claude 正在操作同一项目，本轮结束后可发送。</p>}
        <PromptInput className="rounded-[24px] border-border/60 shadow-[0_2px_12px_hsl(var(--foreground)/0.04)]" status={busy ? 'submitted' : session?.running ? 'streaming' : 'ready'} onSubmit={(event) => { event.preventDefault(); void prompt(); }}>
          <input ref={attachmentPicker} type="file" multiple className="hidden" aria-label="Pi 上传文件" onChange={(event) => {
            const selected = Array.from(event.target.files || []);
            event.target.value = '';
            if (attachments.length + selected.length > MAX_ATTACHMENT_COUNT) { setNote('每条消息最多添加 10 个附件。'); return; }
            if (selected.some((file) => file.size > MAX_ATTACHMENT_SIZE)) { setNote('每个附件不能超过 10MB。'); return; }
            setAttachments((current) => [...current, ...selected]);
            setNote('');
          }} />
          {attachments.length > 0 && <PromptInputHeader><div className="flex flex-wrap gap-2">{attachments.map((file, index) => <div key={`${index}-${file.name}`} className="flex min-w-0 max-w-full items-center gap-2 rounded-lg border border-border/60 bg-muted/40 px-2 py-1 text-xs"><FileIcon className="h-4 w-4 shrink-0" /><span className="max-w-40 truncate" title={file.name}>{file.name}</span><button type="button" aria-label={`移除附件 ${file.name}`} title="移除附件" onClick={() => setAttachments((current) => current.filter((_, i) => i !== index))}><XIcon className="h-3.5 w-3.5" /></button></div>)}</div></PromptInputHeader>}
          <PromptInputBody><PromptInputTextarea aria-label="Pi 输入" aria-description="读取 Claude 上下文，结果保留于 Pi" rows={2} className="min-h-14" placeholder="根据 Claude 对话继续操作…" value={input} onChange={(event) => onInputChange(event.target.value)} onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
              event.preventDefault();
              void prompt();
            }
          }} /></PromptInputBody>
          <PromptInputFooter className="gap-1 px-2 pb-2">
            <PromptInputTools className="min-w-0">
              <PromptInputButton aria-label="Pi 添加附件" title="添加附件" onClick={() => attachmentPicker.current?.click()}><PlusIcon className="h-4 w-4" /></PromptInputButton>
              {session?.runtimeActive && !session.running && !ownedByOtherSession && <PromptInputButton disabled={busy} aria-label="停止 Pi 和本地程序" title="停止 Pi 和本地程序" onClick={() => void stop()}><SquareIcon className="h-3.5 w-3.5" /></PromptInputButton>}
            </PromptInputTools>
            <div className="ml-auto flex min-w-0 items-center gap-1">
              <PiModelMenu />
              <PromptInputSubmit className="h-7 w-7 rounded-full bg-[#ef73b0] text-white hover:bg-[#e85fa4] disabled:opacity-50" aria-label={session?.running ? '停止 Pi 和本地程序' : '发送'} title={session?.running ? '停止 Pi 和本地程序' : '发送'} onClick={session?.running ? () => void stop() : undefined} disabled={busy || ownedByOtherSession || (session?.running ? false : !session || cloudBusy || handingBack || handback === 'failed' || (!input.trim() && attachments.length === 0))}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined}</PromptInputSubmit>
            </div>
          </PromptInputFooter>
        </PromptInput>
      </div>
    </section>
  );
}
