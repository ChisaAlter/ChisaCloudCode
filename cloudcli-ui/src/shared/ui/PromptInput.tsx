import * as React from 'react';
import { ArrowUpIcon, SquareIcon } from 'lucide-react';

import { cn } from '@/shared/utils';
import { Button } from '@/shared/ui/Button';
import { Tooltip } from '@/shared/ui/Tooltip';

/* ─── Context ────────────────────────────────────────────────────── */

type PromptInputStatus = 'ready' | 'submitted' | 'streaming' | 'error';

type PromptInputContextValue = {
  status: PromptInputStatus;
};

const PromptInputContext = React.createContext<PromptInputContextValue | null>(null);

/** Read by PromptInputSubmit, which is only ever rendered inside PromptInput. */
const usePromptInput = () => {
  const context = React.useContext(PromptInputContext);
  if (!context) {
    throw new Error('PromptInput components must be used within PromptInput');
  }
  return context;
};

/* ─── PromptInput (root form) ────────────────────────────────────── */

export type PromptInputProps = {
  status?: PromptInputStatus;
} & React.FormHTMLAttributes<HTMLFormElement>;

/** Form shell used by chat and local-agent to keep their message inputs visually consistent. */
export const PromptInput = React.forwardRef<HTMLFormElement, PromptInputProps>(
  ({ className, status = 'ready', children, ...props }, ref) => {
    const contextValue = React.useMemo(() => ({ status }), [status]);

    return (
      <PromptInputContext.Provider value={contextValue}>
        <form
          ref={ref}
          data-slot="prompt-input"
          className={cn(
            'relative overflow-hidden rounded-2xl border border-border bg-card shadow-sm transition-colors duration-200 focus-within:border-muted-foreground/40',
            className
          )}
          {...props}
        >
          {children}
        </form>
      </PromptInputContext.Provider>
    );
  }
);
PromptInput.displayName = 'PromptInput';

/* ─── PromptInputHeader ──────────────────────────────────────────── */

/** Attachment/queue row above the textarea, used by chat and local-agent composers. */
export const PromptInputHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-slot="prompt-input-header"
    className={cn('px-3 pt-3', className)}
    {...props}
  />
));
PromptInputHeader.displayName = 'PromptInputHeader';

/* ─── PromptInputBody ────────────────────────────────────────────── */

/** Textarea wrapper used by the chat and local-agent message composers. */
export const PromptInputBody = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-slot="prompt-input-body"
    className={cn('relative', className)}
    {...props}
  />
));
PromptInputBody.displayName = 'PromptInputBody';

/* ─── PromptInputTextarea ────────────────────────────────────────── */

/** Message textarea used by chat and local-agent with their own input and resizing handlers. */
export const PromptInputTextarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    data-slot="prompt-input-textarea"
    className={cn(
      'chat-input-placeholder block max-h-[40vh] w-full resize-none overflow-y-auto bg-transparent px-4 py-2 text-sm leading-6 text-foreground placeholder-muted-foreground/50 focus:outline-none sm:max-h-[300px]',
      className
    )}
    {...props}
  />
));
PromptInputTextarea.displayName = 'PromptInputTextarea';

/* ─── PromptInputFooter ──────────────────────────────────────────── */

/** Footer row used by the chat and local-agent message composers. */
export const PromptInputFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-slot="prompt-input-footer"
    className={cn('flex items-center justify-between px-3 pb-3 pt-1', className)}
    {...props}
  />
));
PromptInputFooter.displayName = 'PromptInputFooter';

/* ─── PromptInputTools ───────────────────────────────────────────── */

/** Tool cluster used by the chat and local-agent message composers. */
export const PromptInputTools = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-slot="prompt-input-tools"
    className={cn('flex items-center gap-1', className)}
    {...props}
  />
));
PromptInputTools.displayName = 'PromptInputTools';

/* ─── PromptInputButton ──────────────────────────────────────────── */

export type PromptInputButtonTooltip = {
  content: React.ReactNode;
  shortcut?: string;
  side?: 'top' | 'bottom' | 'left' | 'right';
};

export type PromptInputButtonProps = {
  tooltip?: PromptInputButtonTooltip;
} & React.ButtonHTMLAttributes<HTMLButtonElement>;

/** Composer icon button used by chat, including voice input, and local-agent. */
export const PromptInputButton = React.forwardRef<HTMLButtonElement, PromptInputButtonProps>(
  ({ className, tooltip, children, ...props }, ref) => {
    const button = (
      <Button
        ref={ref}
        type="button"
        variant="ghost"
        size="icon"
        className={cn('h-8 w-8 [&_svg]:size-4', className)}
        {...props}
      >
        {children}
      </Button>
    );

    if (tooltip) {
      return (
        <Tooltip
          content={
            tooltip.shortcut ? (
              <span className="flex items-center gap-1.5">
                {tooltip.content}
                <kbd className="rounded bg-white/20 px-1 text-[10px]">{tooltip.shortcut}</kbd>
              </span>
            ) : (
              tooltip.content
            )
          }
          position={tooltip.side ?? 'top'}
        >
          {button}
        </Tooltip>
      );
    }

    return button;
  }
);
PromptInputButton.displayName = 'PromptInputButton';

/* ─── PromptInputSubmit ──────────────────────────────────────────── */

export type PromptInputSubmitProps = React.ButtonHTMLAttributes<HTMLButtonElement>;

/** Send/stop button used by chat and local-agent; each composer owns its click behavior. */
export const PromptInputSubmit = React.forwardRef<HTMLButtonElement, PromptInputSubmitProps>(
  ({ className, children, ...props }, ref) => {
    // The status comes from the PromptInput root, which is the only place it is set.
    const { status } = usePromptInput();
    const isActive = status === 'submitted' || status === 'streaming';

    return (
      <Button
        ref={ref}
        type={isActive ? 'button' : 'submit'}
        variant="default"
        size="icon"
        className={cn('h-8 w-8 shrink-0 rounded-xl', className)}
        {...props}
      >
        {children ?? (isActive ? (
          <SquareIcon className="h-3.5 w-3.5 fill-current" />
        ) : (
          <ArrowUpIcon className="h-4 w-4" />
        ))}
      </Button>
    );
  }
);
PromptInputSubmit.displayName = 'PromptInputSubmit';

