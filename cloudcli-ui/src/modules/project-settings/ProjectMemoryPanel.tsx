import { useCallback, useEffect, useRef, useState } from 'react';

import { api, ApiRequestError, readApiJson } from '@/shared/api';
import { getAuthSessionVersion } from '@/shared/authToken';
import { getServerConnectionVersion } from '@/shared/chisa';
import { Button } from '@/shared/ui';

type MemoryVersion = { content: string; hash: string };

function readVersion(data: MemoryVersion): MemoryVersion {
  if (!data || typeof data.content !== 'string' || typeof data.hash !== 'string' || !data.hash) throw new Error('Invalid memory response');
  return data;
}

function MemoryEditor({ projectId }: { projectId: string }) {
  // A mounted editor belongs to exactly one app account, service and project.
  const [owner] = useState(() => ({ auth: getAuthSessionVersion(), server: getServerConnectionVersion() }));
  // Keep the accepted compare-and-swap baseline separate from the editable draft.
  const [baseline, setBaseline] = useState<MemoryVersion | null>(null);
  // Draft changes remain local until an explicit save, including an explicit clear.
  const [draft, setDraft] = useState('');
  // A refreshed remote version never replaces unsaved text without a deliberate user action.
  const [remote, setRemote] = useState<MemoryVersion | null>(null);
  // One read or write owns the editor's feedback and prevents overlapping operations.
  const [pending, setPending] = useState<'load' | 'save' | null>('load');
  // A conflict requires a fresh version and an explicit merge or reload before another save.
  const [conflict, setConflict] = useState(false);
  // Read and write failures stay visible alongside the preserved draft.
  const [error, setError] = useState<string | null>(null);
  // Successful save and draft-only actions have distinct feedback.
  const [notice, setNotice] = useState<string | null>(null);
  const baselineRef = useRef(baseline);
  const draftRef = useRef(draft);
  baselineRef.current = baseline;
  draftRef.current = draft;
  const requestRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const owned = useCallback(() => owner.auth === getAuthSessionVersion() && owner.server === getServerConnectionVersion(), [owner]);

  const refresh = useCallback(async () => {
    if (!owned() || controllerRef.current) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    const request = ++requestRef.current;
    const current = () => owned() && !controller.signal.aborted && request === requestRef.current;
    setPending('load'); setError(null); setNotice(null);
    try {
      const result = await readApiJson<{ data: MemoryVersion }>(await api.projectMemory(projectId, { signal: controller.signal }));
      if (!current()) return;
      const version = readVersion(result.data);
      const previous = baselineRef.current;
      if (!previous || draftRef.current === previous.content) {
        setBaseline(version); setDraft(version.content); setRemote(null); setConflict(false);
        setNotice(previous ? '已载入最新云端记忆。' : null);
      } else {
        setRemote(version);
        setNotice('已读取云端版本，未保存的草稿已保留。请比较后选择如何继续。');
      }
    } catch {
      if (current()) setError('无法读取云端项目记忆，请检查连接后重试。');
    } finally {
      if (current()) setPending(null);
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }, [owned, projectId]);

  useEffect(() => {
    void refresh();
    return () => { ++requestRef.current; controllerRef.current?.abort(); controllerRef.current = null; };
  }, [refresh]);

  const save = async () => {
    if (!owned() || controllerRef.current || !baseline || conflict || remote || draft === baseline.content) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    const request = ++requestRef.current;
    const current = () => owned() && !controller.signal.aborted && request === requestRef.current;
    setPending('save'); setError(null); setNotice(null);
    try {
      const result = await readApiJson<{ data: MemoryVersion }>(await api.saveProjectMemory(projectId, { content: draft, expectedHash: baseline.hash }, { signal: controller.signal }));
      if (!current()) return;
      const version = readVersion(result.data);
      setBaseline(version); setDraft(version.content); setRemote(null); setConflict(false);
      setNotice(version.content ? '项目记忆已保存。' : '已保存空记忆。');
    } catch (failure) {
      if (!current()) return;
      if (failure instanceof ApiRequestError && failure.status === 409) {
        setConflict(true);
        setError('云端记忆已被更新，草稿已保留。请刷新云端版本并合并后再保存。');
      } else setError('无法保存项目记忆，草稿已保留，请重试。');
    } finally {
      if (current()) setPending(null);
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  };

  const adoptRemote = (keepDraft: boolean) => {
    if (!owned() || !remote || pending) return;
    setBaseline(remote);
    if (!keepDraft) setDraft(remote.content);
    setRemote(null); setConflict(false); setError(null);
    setNotice(keepDraft ? '已采用最新云端版本作为基准，草稿仍未保存。请合并内容后保存。' : '已用云端版本替换草稿。');
  };
  const dirty = Boolean(baseline && draft !== baseline.content);

  return <div className="mt-4 space-y-4">
    <p className="text-xs leading-relaxed text-muted-foreground">保存在云端，按当前应用账号与项目隔离；不同 Claude 订阅账号共用本项目记忆。</p>
    <p className="text-xs text-muted-foreground">在这里明确编辑并保存；清空只修改草稿，保存后才会清除云端内容。不会自动覆盖未保存的编辑。</p>
    {pending === 'load' && !baseline && <p role="status" className="text-sm text-muted-foreground">正在读取项目记忆…</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-xs text-muted-foreground">{notice}</p>}
    {baseline && <>
      <label className="block space-y-2"><span className="text-sm font-medium">项目记忆内容</span><textarea aria-label="项目记忆内容" value={draft} onChange={event => { setDraft(event.target.value); setNotice(null); }} disabled={Boolean(pending)} rows={10} placeholder="暂无项目记忆，可记录项目约定与长期上下文。" className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm leading-relaxed shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50" /></label>
      {!baseline.content && !draft && <p className="text-xs text-muted-foreground">云端项目记忆为空。</p>}
      <p className="text-xs text-muted-foreground">{dirty ? '有未保存的修改' : '内容与已读取的云端版本一致'}</p>
    </>}
    {remote && <div className="space-y-3 border-t border-border pt-3">
      <details><summary className="cursor-pointer text-xs font-medium">查看最新云端版本</summary><pre className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">{remote.content || '（空记忆）'}</pre></details>
      <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" onClick={() => adoptRemote(true)} disabled={Boolean(pending)}>保留草稿，以云端版本为基准</Button><Button variant="ghost" size="sm" onClick={() => adoptRemote(false)} disabled={Boolean(pending)}>载入云端版本并替换草稿</Button></div>
    </div>}
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
      <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={Boolean(pending)}>{pending === 'load' ? '正在刷新…' : '刷新云端版本'}</Button>
      {baseline && <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" onClick={() => { if (owned()) { setDraft(''); setNotice('草稿已清空，保存后才会清除云端记忆。'); } }} disabled={Boolean(pending) || !draft}>清空草稿</Button><Button size="sm" onClick={() => void save()} disabled={Boolean(pending) || !dirty || conflict || Boolean(remote)}>{pending === 'save' ? '保存中…' : '保存项目记忆'}</Button></div>}
    </div>
  </div>;
}

/** ProjectSettingsDialog's memory tab edits app-account/project cloud memory through explicit compare-and-swap saves. */
export default function ProjectMemoryPanel({ projectId }: { projectId: string }) {
  const ownerKey = JSON.stringify([projectId, getAuthSessionVersion(), getServerConnectionVersion()]);
  return <MemoryEditor key={ownerKey} projectId={projectId} />;
}
