import { useEffect, useRef, useSyncExternalStore } from 'react';
import { Loader2 } from 'lucide-react';

import { Dialog, DialogContent, DialogTitle } from '@/shared/ui/Dialog';
import { subscribeWorkspaceSynchronization } from '@/shared/chisa';
import { getBlockingOperations, subscribeBlockingOperations } from '@/shared/utils';

/** App mounts this once for chat, desktop settings and project creation operations. */
export function BlockingOperationDialog() {
  const operations = useSyncExternalStore(subscribeBlockingOperations, getBlockingOperations);
  const operation = operations.filter(item => item.blocking).at(-1);
  const backgroundOperation = operations.filter(item => !item.blocking).at(-1);
  const panel = useRef<HTMLDivElement>(null);
  const busy = Boolean(operation);

  useEffect(subscribeWorkspaceSynchronization, []);

  useEffect(() => {
    if (!busy) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const background = Array.from(document.body.children)
      .filter((element): element is HTMLElement => element instanceof HTMLElement && !element.contains(panel.current));
    const previousInert = background.map(element => element.inert);
    background.forEach(element => { element.inert = true; });
    panel.current?.focus();
    // Existing dialogs and global shortcuts must not react while work is pending.
    const blockKeys = (event: KeyboardEvent) => { event.preventDefault(); event.stopImmediatePropagation(); };
    window.addEventListener('keydown', blockKeys, true);
    return () => {
      window.removeEventListener('keydown', blockKeys, true);
      background.forEach((element, index) => { element.inert = previousInert[index]!; });
      previouslyFocused?.focus();
    };
  }, [busy]);

  return (
    <>
      {!busy && backgroundOperation && (
        <div role="status" aria-live="polite" className="pointer-events-none fixed right-4 top-14 z-[1000] flex max-w-sm items-start gap-3 rounded-xl border bg-card px-4 py-3 text-sm shadow-sm">
          <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-primary" aria-hidden="true" />
          <div><p className="font-medium">{backgroundOperation.title}</p><p className="mt-1 text-xs text-muted-foreground">{backgroundOperation.detail}</p></div>
        </div>
      )}
    <Dialog open={busy} onOpenChange={() => {}}>
      <DialogContent ref={panel} tabIndex={-1} aria-labelledby="blocking-operation-title" aria-describedby="blocking-operation-detail" aria-busy="true" wrapperClassName="z-[10000]" className="max-w-sm p-7 text-center outline-none">
        <Loader2 className="mx-auto mb-4 h-8 w-8 animate-spin text-primary" aria-hidden="true" />
        <DialogTitle id="blocking-operation-title" className="not-sr-only text-base font-semibold">{operation?.title}</DialogTitle>
        <p id="blocking-operation-detail" role="status" aria-live="polite" className="mt-2 text-sm leading-6 text-muted-foreground">{operation?.detail}</p>
      </DialogContent>
    </Dialog>
    </>
  );
}
