import { access, readdir } from 'node:fs/promises';
import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';
import { resolveProviderHome } from '@/modules/providers/services/provider-state.service.js';
import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderCurrentActiveModel,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  sanitizeLeafDirectoryName,
} from '@/shared/utils.js';

/** Curated Cursor catalog shipped as immutable CloudCLI defaults. */
export const CURSOR_PREDEFINED_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'auto', label: 'Auto', description: 'Let Cursor choose the model.' },
    {
      value: 'composer-2.5-fast',
      label: 'Composer 2.5 Fast',
      description: 'Cursor Composer 2.5 with faster inference.',
    },
    {
      value: 'composer-2.5',
      label: 'Composer 2.5',
      description: 'Cursor model for efficient, long-running coding tasks.',
    },
    { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
    { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
    { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
    { value: 'gpt-5.5', label: 'GPT-5.5' },
    { value: 'claude-fable-5', label: 'Claude Fable 5' },
    { value: 'claude-opus-5', label: 'Claude Opus 5' },
    { value: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
    { value: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
    { value: 'grok-4.5', label: 'Grok 4.5' },
    { value: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro' },
    { value: 'kimi-k2.5', label: 'Kimi K2.5' },
  ],
  DEFAULT: 'auto',
};



const resolveCursorSessionStorePath = async (sessionId: string): Promise<string | null> => {
  const row = sessionsDb.getSessionById(sessionId) ?? sessionsDb.getSessionByProviderSessionId(sessionId);
  const safeSessionId = sanitizeLeafDirectoryName(row?.provider_session_id ?? sessionId, 'cursor session id');
  const chatsRoot = path.join(resolveProviderHome('cursor', sessionId), '.cursor', 'chats');

  try {
    const workspaceEntries = await readdir(chatsRoot, { withFileTypes: true });
    for (const workspaceEntry of workspaceEntries) {
      if (!workspaceEntry.isDirectory()) {
        continue;
      }

      const storeDbPath = path.join(chatsRoot, workspaceEntry.name, safeSessionId, 'store.db');
      try {
        await access(storeDbPath);
        return storeDbPath;
      } catch {
        // Keep scanning sibling workspaces until the matching session directory is found.
      }
    }
  } catch {
    return null;
  }

  return null;
};

/** Provider registry model adapter for Cursor predefined models and session metadata. */
export class CursorProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    return CURSOR_PREDEFINED_MODELS;
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    if (!sessionId?.trim()) {
      return buildDefaultProviderCurrentActiveModel(CURSOR_PREDEFINED_MODELS);
    }

    try {
      const storeDbPath = await resolveCursorSessionStorePath(sessionId);
      if (!storeDbPath) {
        return buildDefaultProviderCurrentActiveModel(CURSOR_PREDEFINED_MODELS);
      }

      const { default: Database } = await import('better-sqlite3');
      const db = new Database(storeDbPath, { readonly: true, fileMustExist: true });

      try {
        const row = db.prepare(`SELECT value FROM meta WHERE key='0' LIMIT 1;`).get() as {
          value?: Buffer | string;
        } | undefined;
        const metadataText = Buffer.isBuffer(row?.value)
          ? row.value.toString('utf8')
          : typeof row?.value === 'string' && row.value.trim()
            ? Buffer.from(row.value.trim(), 'hex').toString('utf8')
            : '';
        if (!metadataText) {
          return buildDefaultProviderCurrentActiveModel(CURSOR_PREDEFINED_MODELS);
        }

        const metadata = JSON.parse(metadataText) as { lastUsedModel?: string };
        if (typeof metadata.lastUsedModel === 'string' && metadata.lastUsedModel.trim()) {
          return {
            model: metadata.lastUsedModel.trim(),
          };
        }
      } finally {
        db.close();
      }
    } catch {
      // Fall through to the curated default when Cursor metadata cannot be read.
    }

    return buildDefaultProviderCurrentActiveModel(CURSOR_PREDEFINED_MODELS);
  }
}
