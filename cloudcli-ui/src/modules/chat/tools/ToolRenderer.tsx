import React, { memo, useMemo, useCallback } from 'react';

import type { DiffLine, Project,ToolStatus } from '@/shared/types';
import { useWorkspaceExecutionScope, useWorkspaceScope } from '@/shared/context/WorkspaceScopeContext';
import { useSshJobOutputStream } from '@/shared/hooks/useSshJobOutputStream';
import { formatToolDisplayName, getToolConfig } from '@/modules/chat/tools/configs/toolConfigs';
import { OneLineDisplay } from '@/modules/chat/tools/OneLineDisplay';
import { BashCommandDisplay } from '@/modules/chat/tools/BashCommandDisplay';
import { BashEditDiff } from '@/modules/chat/tools/BashEditDiff';
import { CollapsibleDisplay } from '@/modules/chat/tools/CollapsibleDisplay';
import { ToolDiffViewer } from '@/modules/chat/tools/ToolDiffViewer';
import { MarkdownContent } from '@/modules/chat/tools/ContentRenderers/MarkdownContent';
import { FileListContent } from '@/modules/chat/tools/ContentRenderers/FileListContent';
import { TodoListContent } from '@/modules/chat/tools/ContentRenderers/TodoListContent';
import { TaskListContent } from '@/modules/chat/tools/ContentRenderers/TaskListContent';
import { TextContent } from '@/modules/chat/tools/ContentRenderers/TextContent';
import { QuestionAnswerContent } from '@/modules/chat/tools/ContentRenderers/QuestionAnswerContent';
import { PlanDisplay } from '@/modules/chat/tools/PlanDisplay';
import { ToolStatusBadge } from '@/modules/chat/tools/ToolStatusBadge';
import { DiffStatsBadge } from '@/modules/chat/tools/DiffStatsBadge';
import { parseToolPayload, summarizeDiff } from '@/modules/chat/utils/messageTransforms';

type ToolRendererProps = {
  toolName: string;
  toolInput: any;
  toolResult?: any;
  toolId?: string;
  mode: 'input' | 'result';
  onFileOpen?: (filePath: string, diffInfo?: any) => void;
  createDiff?: (oldStr: string, newStr: string) => DiffLine[];
  selectedProject?: Project | null;
  showRawParameters?: boolean;
  rawToolInput?: string;
  /** Lifecycle the provider reported, when it reports one. Overrides the result-based inference. */
  toolStatus?: string;
};

const COMMAND_TOOL_NAMES = new Set(['Bash', 'PowerShell', 'mcp__workspace__run_command']);

function getToolCategory(toolName: string): string {
  if (['Edit', 'Write', 'ApplyPatch'].includes(toolName)) return 'edit';
  if (['Grep', 'Glob'].includes(toolName)) return 'search';
  if (COMMAND_TOOL_NAMES.has(toolName)) return 'bash';
  if (['TodoWrite', 'TodoRead'].includes(toolName)) return 'todo';
  if (['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'].includes(toolName)) return 'task';
  if (toolName === 'Task') return 'agent';
  if (toolName === 'exit_plan_mode' || toolName === 'ExitPlanMode') return 'plan';
  if (toolName === 'AskUserQuestion') return 'question';
  return 'default';
}

function unwrapMcpTextContent(rawContent: unknown): string {
  if (Array.isArray(rawContent)) {
    const textParts = rawContent
      .filter((part: any) => part && part.type === 'text' && typeof part.text === 'string')
      .map((part: any) => part.text);
    return textParts.length > 0 ? textParts.join('\n') : JSON.stringify(rawContent, null, 2);
  }
  if (typeof rawContent === 'string') {
    try {
      const parsed = JSON.parse(rawContent);
      if (Array.isArray(parsed)) {
        const textParts = parsed
          .filter((part: any) => part && part.type === 'text' && typeof part.text === 'string')
          .map((part: any) => part.text);
        if (textParts.length > 0) return textParts.join('\n');
      }
    } catch {
      // Plain text or non-array JSON
    }
    return rawContent;
  }
  return rawContent != null ? String(rawContent) : '';
}

function extractCommandToolOutput(toolName: string, toolResult: any): { output: string; isError: boolean } {
  if (!toolResult) return { output: '', isError: false };
  const rawText = unwrapMcpTextContent(toolResult.content);
  if (toolName === 'mcp__workspace__run_command' && rawText.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(rawText) as {
        stdout?: unknown;
        stderr?: unknown;
        exitCode?: unknown;
        truncated?: unknown;
      };
      if (parsed && typeof parsed === 'object' && ('stdout' in parsed || 'stderr' in parsed || 'exitCode' in parsed)) {
        const stdout = typeof parsed.stdout === 'string' ? parsed.stdout : '';
        const stderr = typeof parsed.stderr === 'string' ? parsed.stderr : '';
        const parts: string[] = [];
        if (stdout) parts.push(stdout.replace(/\r?\n$/, ''));
        if (stderr) parts.push(`[stderr]\n${stderr.replace(/\r?\n$/, '')}`);
        if (parsed.truncated) parts.push('[output truncated]');
        const exitCode = typeof parsed.exitCode === 'number' ? parsed.exitCode : 0;
        if (exitCode !== 0 && parts.length === 0) parts.push(`[exit ${exitCode}]`);
        return {
          output: parts.join('\n'),
          isError: Boolean(toolResult.isError) || exitCode !== 0,
        };
      }
    } catch {
      // Fall back to raw text
    }
  }
  return { output: rawText, isError: Boolean(toolResult.isError) };
}

// Exact denial messages from the Claude runtime adapter — other providers can't reliably signal denial
const CLAUDE_DENIAL_MESSAGES = [
  'user denied tool use',
  'tool disallowed by settings',
  'permission request timed out',
  'permission request cancelled',
];

function deriveToolStatus(toolResult: any, reportedStatus?: string): ToolStatus {
  // Codex reports a command's lifecycle directly, so a row can show as running
  // while its output is still streaming in rather than only once it finishes.
  if (reportedStatus === 'in_progress') return 'running';
  if (reportedStatus === 'failed') return 'error';
  if (!toolResult) return 'running';
  if (toolResult.isError) {
    const content = String(toolResult.content || '').toLowerCase().trim();
    if (CLAUDE_DENIAL_MESSAGES.some((msg) => content.includes(msg))) {
      return 'denied';
    }
    return 'error';
  }
  return 'completed';
}

/**
 * Main tool renderer router
 * Routes to OneLineDisplay or CollapsibleDisplay based on tool config
 *
 * Rendered by chat's MessageComponent for every tool call and tool result in
 * the transcript; it is the single entry point for tool presentation.
 */
export const ToolRenderer: React.FC<ToolRendererProps> = memo(({
  toolName,
  toolInput,
  toolResult,
  toolId,
  mode,
  onFileOpen,
  createDiff,
  selectedProject,
  showRawParameters = false,
  rawToolInput,
  toolStatus: reportedStatus,
}) => {
  const config = getToolConfig(toolName);
  const displayConfig: any = mode === 'input' ? config.input : config.result;
  // Namespaced MCP ids are unreadable as-is; every renderer gets the friendly
  // form while lookups keep using the provider's real tool name.
  const displayName = formatToolDisplayName(toolName);

  const parsedData = useMemo(
    () => parseToolPayload(mode === 'input' ? toolInput : toolResult),
    [mode, toolInput, toolResult],
  );

  // Only derive and show status badge on input renders
  const toolStatus = useMemo(
    () => mode === 'input' ? deriveToolStatus(toolResult, reportedStatus) : undefined,
    [mode, toolResult, reportedStatus],
  );

  const primaryWorkspaceScope = useWorkspaceScope();
  const executionWorkspaceScope = useWorkspaceExecutionScope();
  const workspaceScope = primaryWorkspaceScope ?? executionWorkspaceScope;
  const isCommandTool = COMMAND_TOOL_NAMES.has(toolName);
  const isSshCommand = isCommandTool && (
    toolName === 'mcp__workspace__run_command'
    || selectedProject?.sourceMode === 'ssh'
    || workspaceScope?.sourceMode === 'ssh'
  );
  const sshProjectId = selectedProject?.projectId ?? workspaceScope?.projectId ?? null;
  const liveJobOutput = useSshJobOutputStream({
    enabled: Boolean(mode === 'input' && isSshCommand && toolStatus === 'running' && sshProjectId),
    projectId: sshProjectId,
    generation: workspaceScope?.generation,
  });

  const handleAction = useCallback(() => {
    if (displayConfig?.action === 'open-file' && onFileOpen) {
      const value = displayConfig.getValue?.(parsedData) || '';
      onFileOpen(value);
    }
  }, [displayConfig, parsedData, onFileOpen]);

  if (!displayConfig) return null;

  // Bash renders as a Codex-style command row: the command on a single line with
  // a chevron that expands to show the output inline. The combined view lives on
  // the input render; the separate result section is suppressed in MessageComponent.
  // Files the command changed are listed under the row, outside its collapse, so
  // they read like the Edit rows they stand in for.
  if (isCommandTool && mode === 'input') {
    const command = typeof parsedData === 'object' && parsedData !== null && 'command' in parsedData
      ? String(parsedData.command || '')
      : typeof toolInput === 'string'
        ? toolInput
        : typeof rawToolInput === 'string'
          ? rawToolInput
          : '';
    const description = typeof parsedData === 'object' && parsedData !== null && 'description' in parsedData
      ? String(parsedData.description || '')
      : typeof parsedData === 'object' && parsedData !== null && 'path' in parsedData && parsedData.path && parsedData.path !== '/workspace'
        ? `in ${String(parsedData.path)}`
        : undefined;
    const { output: completedOutput, isError } = extractCommandToolOutput(toolName, toolResult);
    const liveOutputText = [
      liveJobOutput.stdout.replace(/\r?\n$/, ''),
      liveJobOutput.stderr ? `[stderr]\n${liveJobOutput.stderr.replace(/\r?\n$/, '')}` : '',
    ].filter(Boolean).join('\n');
    const output = completedOutput || liveOutputText;
    const effectiveStatus = !completedOutput && isError ? 'error' : toolStatus;
    return (
      <>
        <BashCommandDisplay
          command={command}
          description={description}
          output={output}
          isError={isError}
          status={effectiveStatus !== 'completed' ? effectiveStatus : undefined}
          // Commands stay collapsed by default once completed — including failures;
          // while an SSH command is actively streaming live output, auto-open once.
          defaultOpen={Boolean(!completedOutput && liveOutputText)}
        />
        <BashEditDiff
          toolUseResult={toolResult?.toolUseResult}
          onFileOpen={onFileOpen}
          projectRoot={selectedProject?.fullPath}
        />
      </>
    );
  }

  if (displayConfig.type === 'one-line') {
    const value = displayConfig.getValue?.(parsedData) || '';
    const secondary = displayConfig.getSecondary?.(parsedData);

    return (
      <OneLineDisplay
        toolName={displayName}
        toolResult={toolResult}
        toolId={toolId}
        icon={displayConfig.icon}
        label={displayConfig.label}
        value={value}
        secondary={secondary}
        action={displayConfig.action}
        onAction={handleAction}
        style={displayConfig.style}
        wrapText={displayConfig.wrapText}
        colorScheme={displayConfig.colorScheme}
        resultId={mode === 'input' ? `tool-result-${toolId}` : undefined}
        status={toolStatus !== 'completed' ? toolStatus : undefined}
      />
    );
  }

  if (displayConfig.type === 'plan') {
    const title = typeof displayConfig.title === 'function'
      ? displayConfig.title(parsedData)
      : displayConfig.title || 'Plan';

    const contentProps = displayConfig.getContentProps?.(parsedData, {
      selectedProject,
      createDiff,
      onFileOpen
    }) || {};

    const isStreaming = mode === 'input' && !toolResult;

    return (
      <PlanDisplay
        projectId={selectedProject?.projectId}
        title={title}
        content={contentProps.content || ''}
        defaultOpen={displayConfig.defaultOpen ?? false}
        isStreaming={isStreaming}
        showRawParameters={mode === 'input' && showRawParameters}
        rawContent={rawToolInput}
        toolName={toolName}
        toolId={toolId}
      />
    );
  }

  if (displayConfig.type === 'collapsible') {
    const title = typeof displayConfig.title === 'function'
      ? displayConfig.title(parsedData)
      : displayConfig.title || 'Details';

    const defaultOpen = displayConfig.defaultOpen !== undefined
      ? displayConfig.defaultOpen
      : false;

    const contentProps = displayConfig.getContentProps?.(parsedData, {
      selectedProject,
      createDiff,
      onFileOpen
    }) || {};

    let contentComponent: React.ReactNode = null;

    switch (displayConfig.contentType) {
      case 'diff':
        if (createDiff) {
          contentComponent = (
            <ToolDiffViewer
              {...contentProps}
              createDiff={createDiff}
              onFileClick={() => onFileOpen?.(contentProps.filePath)}
            />
          );
        }
        break;

      case 'markdown':
        contentComponent = <MarkdownContent projectId={selectedProject?.projectId} content={contentProps.content || ''} />;
        break;

      case 'file-list':
        contentComponent = (
          <FileListContent
            files={contentProps.files || []}
            onFileClick={onFileOpen}
            title={contentProps.title}
          />
        );
        break;

      case 'todo-list':
        if (contentProps.todos?.length > 0) {
          contentComponent = (
            <TodoListContent
              todos={contentProps.todos}
              isResult={contentProps.isResult}
            />
          );
        }
        break;

      case 'task':
        contentComponent = <TaskListContent content={contentProps.content || ''} />;
        break;

      case 'question-answer':
        contentComponent = (
          <QuestionAnswerContent
            questions={contentProps.questions || []}
            answers={contentProps.answers || {}}
          />
        );
        break;

      case 'text':
        contentComponent = (
          <TextContent
            content={contentProps.content || ''}
            format={contentProps.format || 'plain'}
          />
        );
        break;

      case 'success-message': {
        const msg = displayConfig.getMessage?.(parsedData) || 'Success';
        contentComponent = (
          <div className="flex items-center gap-1.5 text-xs text-green-600 dark:text-green-400">
            <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            {msg}
          </div>
        );
        break;
      }
    }

    const handleTitleClick = (toolName === 'Edit' || toolName === 'Write' || toolName === 'ApplyPatch') && contentProps.filePath && onFileOpen
      ? () => onFileOpen(contentProps.filePath, {
          old_string: contentProps.oldContent,
          new_string: contentProps.newContent
        })
      : undefined;

    // Not memoized on purpose: `createDiff` is the session's cached calculator,
    // so this is a Map hit on the same key ToolDiffViewer is about to use.
    const diffStats = displayConfig.contentType === 'diff'
      && createDiff
      && typeof contentProps.oldContent === 'string'
      && typeof contentProps.newContent === 'string'
      ? summarizeDiff(createDiff(contentProps.oldContent, contentProps.newContent))
      : null;

    const statusBadge = toolStatus && toolStatus !== 'completed'
      ? <ToolStatusBadge status={toolStatus} />
      : null;
    const statsBadge = diffStats ? <DiffStatsBadge stats={diffStats} /> : null;
    // The header is sticky while the section is open, so the counts stay
    // visible over a long diff rather than scrolling away with it.
    const badgeElement = statusBadge || statsBadge
      ? (
        <span className="inline-flex items-center gap-1.5">
          {statsBadge}
          {statusBadge}
        </span>
      )
      : undefined;

    return (
      <CollapsibleDisplay
        toolName={displayName}
        toolId={toolId}
        title={title}
        defaultOpen={defaultOpen}
        onTitleClick={handleTitleClick}
        badge={badgeElement}
        showRawParameters={mode === 'input' && showRawParameters}
        rawContent={rawToolInput}
        toolCategory={getToolCategory(toolName)}
      >
        {contentComponent}
      </CollapsibleDisplay>
    );
  }

  return null;
});

ToolRenderer.displayName = 'ToolRenderer';
