import { readFile } from 'node:fs/promises';

import { sessionsDb } from '@/modules/database/index.js';
import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ClaudeModelEvent,
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import { buildDefaultProviderCurrentActiveModel, extractClaudeResolvedModel } from '@/shared/utils.js';

/**
 * Ultracode is not one of the SDK's reasoning-effort levels. Selecting it runs the turn at
 * `xhigh` effort with standing dynamic-workflow orchestration, which the Claude runtime
 * translates into the session-scoped `ultracode` setting. It is therefore only offered on
 * models this catalog already marks as xhigh-capable.
 */
export const CLAUDE_ULTRACODE_EFFORT = 'ultracode';

const ULTRACODE_EFFORT_OPTION = {
  value: CLAUDE_ULTRACODE_EFFORT,
  description: 'Highest effort plus standing workflow orchestration.',
};

export const CLAUDE_PREDEFINED_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'default',
      label: 'Default (auto)',
      description: 'Use the recommended model for your Claude account and deployment.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'best',
      label: 'Best available (auto)',
      description: 'Use Fable when available, otherwise the deployment-selected Opus model.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'fable',
      label: 'Fable (auto)',
      description: 'Most capable Claude model for the hardest, longest-running tasks.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'sonnet',
      label: 'Sonnet (auto)',
      description: 'Latest Sonnet model for everyday coding tasks.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'sonnet[1m]',
      label: 'Sonnet (auto, 1M context)',
      description: 'Latest Sonnet model with a 1M context window.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'opus',
      label: 'Opus (auto)',
      description: 'Version selected by Claude Code and deployment settings; not pinned.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'opus[1m]',
      label: 'Opus (auto, 1M context)',
      description: 'Deployment-selected Opus version with a 1M context window; not pinned.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'haiku',
      label: 'Haiku (auto)',
      description: 'Fast and efficient Claude model for simple tasks.',
    },
    {
      value: 'opusplan',
      label: 'Opus Plan (auto)',
      description: 'Use Opus while planning, then switch to Sonnet for execution.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
  ],
  DEFAULT: 'default',
};

// Explicit IDs bypass family aliases. Current releases are listed first; older
// pins remain valid selections. Verified against the official model catalog on
// 2026-10-15: https://platform.claude.com/docs/en/models/overview
const pinnedModelOptions: ProviderModelOption[] = [];
for (const [value, label, effortTemplate, defaultEffort] of [
  ['claude-opus-5-5', 'Opus 5.5', 'opus', 'medium'],
  ['claude-fable-5-1', 'Fable 5.1', 'fable'],
  ['claude-sonnet-5-5', 'Sonnet 5.5', 'sonnet', 'medium'],
  // Haiku 5.5 supports the same effort levels as Opus, unlike legacy Haiku 4.5.
  ['claude-haiku-5-5', 'Haiku 5.5', 'opus', 'medium'],
  ['claude-fable-5', 'Fable 5', 'fable'],
  ['claude-opus-5', 'Opus 5', 'opus'],
  ['claude-opus-4-8', 'Opus 4.8', 'opus'],
  ['claude-opus-4-8[1m]', 'Opus 4.8 (1M context)', 'opus[1m]'],
  ['claude-sonnet-5', 'Sonnet 5', 'sonnet'],
  ['claude-haiku-4-5-20251001', 'Haiku 4.5', 'haiku'],
]) {
  const template = CLAUDE_PREDEFINED_MODELS.OPTIONS.find((option) => option.value === effortTemplate);
  pinnedModelOptions.push({
    value,
    label,
    description: `Pinned: ${value}`,
    effort: template?.effort && defaultEffort
      ? { ...template.effort, default: defaultEffort } : template?.effort,
  });
}
CLAUDE_PREDEFINED_MODELS.OPTIONS.unshift(...pinnedModelOptions);

export const findClaudeModelOption = (model: string | undefined | null): ProviderModelOption | null => {
  const normalizedModel = typeof model === 'string' ? model.trim() : '';
  if (!normalizedModel) {
    return null;
  }

  return CLAUDE_PREDEFINED_MODELS.OPTIONS.find((option) => option.value === normalizedModel) ?? null;
};


const ANSI_PATTERN = new RegExp(
  '[\\u001B\\u009B][[\\]()#;?]*(?:'
  + '(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]'
  + '|(?:[\\dA-PR-TZcf-ntqry=><~]))',
  'g',
);

/**
 * Claude Code stamps locally-synthesized rows (API-error placeholders and the
 * like) with `model: "<synthetic>"`. Angle-bracketed values are placeholders,
 * never real model ids, and must not be surfaced as the session's model.
 */
const isPlaceholderModel = (model: string): boolean => model.startsWith('<') && model.endsWith('>');

/** Exported for tests. */
export const extractClaudeEventModel = (event: ClaudeModelEvent, sessionId: string): string | null => {
  const eventSessionId = event.sessionId ?? event.session_id;
  if (eventSessionId && eventSessionId !== sessionId) {
    return null;
  }

  const contentModel = extractClaudeModelFromMessageContent(event.message?.content);
  if (contentModel) {
    return contentModel;
  }

  const directModel = event.model?.trim();
  if (directModel && !isPlaceholderModel(directModel)) {
    return directModel;
  }

  const messageModel = event.message?.model?.trim();
  return messageModel && !isPlaceholderModel(messageModel) ? messageModel : null;
};

const stripAnsi = (value: string): string => value.replace(ANSI_PATTERN, '');

const extractTaggedContent = (content: string, tagName: string): string | null => {
  const escapedTagName = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<${escapedTagName}>([\\s\\S]*?)<\\/${escapedTagName}>`).exec(content);
  return match ? match[1] : null;
};

const extractClaudeModelFromTextContent = (content: string): string | null => {
  const localCommandStdout = extractTaggedContent(content, 'local-command-stdout');
  if (localCommandStdout !== null) {
    const cleanedStdout = stripAnsi(localCommandStdout).replace(/\s+/g, ' ').trim();
    const changedModel = /(?:set|changed|switched)\s+model\s+to\s+(.+?)\.?$/i.exec(cleanedStdout);
    const stdoutModel = changedModel?.[1]?.trim();
    // A placeholder stdout hit must not shadow a real <model> tag further down.
    if (stdoutModel && !isPlaceholderModel(stdoutModel)) {
      return stdoutModel;
    }
  }

  const modelTag = extractTaggedContent(content, 'model')?.trim();
  return modelTag && !isPlaceholderModel(modelTag) ? modelTag : null;
};

const extractClaudeModelFromMessageContent = (content: unknown): string | null => {
  if (typeof content === 'string') {
    return extractClaudeModelFromTextContent(content);
  }

  if (!Array.isArray(content)) {
    return null;
  }

  for (const part of content) {
    if (!part || typeof part !== 'object' || !('text' in part) || typeof part.text !== 'string') {
      continue;
    }

    // extractClaudeModelFromTextContent rejects placeholders, so a placeholder
    // part yields null here and a later part can still supply the real model.
    const model = extractClaudeModelFromTextContent(part.text);
    if (model) {
      return model;
    }
  }

  return null;
};


const readClaudeSessionModelFromJsonl = async (
  sessionId: string,
  jsonlPath: string,
): Promise<ProviderCurrentActiveModel | null> => {
  const content = await readFile(jsonlPath, 'utf8');
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  let activeModel: string | null = null;
  let resolvedModel: string | null = null;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const event = JSON.parse(lines[index]) as ClaudeModelEvent;
      if (event.session_id && event.session_id !== sessionId) continue;
      if (event.sessionId && event.sessionId !== sessionId) continue;
      if (event.parent_tool_use_id || event.isSidechain) continue;
      activeModel ??= extractClaudeEventModel(event, sessionId);
      resolvedModel ??= extractClaudeResolvedModel(event);
      if (activeModel && resolvedModel) break;
    } catch {
      // Skip malformed JSONL lines that can happen during concurrent writes.
    }
  }

  return activeModel ? { model: activeModel, resolvedModel } : null;
};

export class ClaudeProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    // claude creates a new jsonl file as a separate session for this request.
    // As a result, it lists the workspace where this is invoked when it shouldn't.
    //
    // Disabled for now:
    // const queryInstance = query({
    //   prompt: 'Get supported models',
    //   options: buildClaudeQueryOptions(),
    // });
    // const supportedModels = await queryInstance.supportedModels();
    // queryInstance.close();
    // return buildClaudeModelsDefinition(supportedModels);
    return CLAUDE_PREDEFINED_MODELS;
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    if (!sessionId?.trim()) {
      return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
    }

    try {
      const session = sessionsDb.getSessionById(sessionId);
      const activeModel = session?.jsonl_path
        ? await readClaudeSessionModelFromJsonl(session.provider_session_id || sessionId, session.jsonl_path)
        : null;
      if (activeModel?.model) {
        return activeModel;
      }
    } catch {
      // Fall through to the provider default when the session-backed lookup fails.
    }

    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }
}
