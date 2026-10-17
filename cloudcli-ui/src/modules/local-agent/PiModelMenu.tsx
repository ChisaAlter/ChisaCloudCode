import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Box, ChevronDown, Pencil } from 'lucide-react';

import { FrontendBridge, onPiConfigChanged } from '@/shared/chisa';
import { useComposerMenuAnchor } from '@/shared/hooks/useComposerMenuAnchor';
import { ComposerMenuHeading, ComposerMenuItem, ComposerMenuSeparator, ComposerMenuSurface } from '@/shared/ui/ComposerMenu';
import { PiAgentSettings } from '@/modules/local-agent/PiAgentSettings';
import type { PiConfigView } from '@/shared/types';

/** PiAgentPanel uses this model picker and its separate custom configuration page. */
export function PiModelMenu() {
  // Keep both popup pages outside the transcript and composer layout.
  const [isOpen, setIsOpen] = useState(false);
  // Start with the model list; the footer opens the configuration form.
  const [page, setPage] = useState<'models' | 'config'>('models');
  // Show the saved model in the trigger and update it after a successful native save.
  const [config, setConfig] = useState<PiConfigView | null>(null);
  // Distinguish an unread configuration from a model that has not been configured.
  const [readError, setReadError] = useState('');
  const close = useCallback(() => setIsOpen(false), []);
  const { triggerRef, menuRef, anchor, updateAnchor } = useComposerMenuAnchor(isOpen, close, 352);

  useEffect(() => {
    let alive = true;
    let revision = 0;
    const unsubscribe = onPiConfigChanged(view => {
      revision++;
      setConfig(view);
      setReadError('');
    });
    const initialRevision = revision;
    void FrontendBridge.piGetConfig().then(view => {
      if (!alive || revision !== initialRevision) return;
      if (view.ok === false) throw new Error(view.error || '读取 Pi 模型失败');
      setConfig(view);
    }).catch(error => {
      if (alive && revision === initialRevision) setReadError(error instanceof Error ? error.message : '读取 Pi 模型失败');
    });
    return () => { alive = false; unsubscribe(); };
  }, []);

  return <>
    <button ref={triggerRef} type="button" aria-label="Pi 选择模型" aria-haspopup={page === 'models' ? 'menu' : 'dialog'} aria-expanded={isOpen}
      title={config?.model || '选择模型'}
      className="flex h-8 min-w-0 max-w-28 items-center gap-1 rounded-lg px-2 text-xs text-foreground transition-colors hover:bg-muted/60 sm:max-w-56"
      onClick={() => { updateAnchor(); setPage('models'); setIsOpen(previous => !previous); }}>
      <span className="truncate">{config?.model || '选择模型'}</span>
      <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
    </button>
    {isOpen && anchor && createPortal(
      <ComposerMenuSurface anchor={anchor} menuRef={menuRef} ariaLabel={page === 'models' ? 'Pi 选择模型' : 'Pi 自定义模型配置'} role={page === 'models' ? 'menu' : 'dialog'}>
        {page === 'models' ? <div className="w-80 max-w-full py-1">
          <ComposerMenuHeading>选择模型</ComposerMenuHeading>
          <ComposerMenuSeparator />
          {config?.model ? <>
            <ComposerMenuHeading>{config.provider === 'custom' ? '自定义模型' : config.provider}</ComposerMenuHeading>
            <ComposerMenuItem label={config.model} icon={<Box className="h-4 w-4" />} isSelected
              className="py-2"
              onSelect={() => { close(); triggerRef.current?.focus(); }} />
          </> : <p role="status" className="px-2.5 py-3 text-xs text-muted-foreground">
            {readError || (config ? '尚未配置模型' : '正在读取模型…')}
          </p>}
          <ComposerMenuSeparator />
          <ComposerMenuItem label="配置自定义模型" icon={<Pencil className="h-4 w-4" />} isSelected={false} role="menuitem"
            className="py-2" onSelect={() => setPage('config')} />
        </div> : <>
          <button type="button" className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-xs hover:bg-accent"
            onClick={() => setPage('models')}>
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden />返回模型列表
          </button>
          <ComposerMenuSeparator />
          <PiAgentSettings compact />
        </>}
      </ComposerMenuSurface>, document.body,
    )}
  </>;
}
