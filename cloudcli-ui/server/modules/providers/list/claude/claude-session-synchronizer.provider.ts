import os from 'node:os';
import path from 'node:path';
import { lstat, readFile, readdir } from 'node:fs/promises';

import { sessionsDb, userDb } from '@/modules/database/index.js';
import { assertCloudWorkspaceOwner } from '@/modules/workspace-runtime/index.js';
import { assertSshProjectOwner, resolveSshProjectTarget } from '@/modules/workspace-bridge/index.js';
import { claudeHistoryRoots, resolveClaudeHistoryArtifact } from '@/modules/providers/services/claude-account-history.service.js';
import { assertSshSessionAccess } from '@/modules/providers/services/ssh-session-access.service.js';
import {
  buildLookupMap,
  extractFirstValidJsonlData,
  normalizeSessionName,
  readFileTimestamps,
} from '@/shared/utils.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';

type ParsedSession = {
  sessionId: string;
  projectPath: string;
  sessionName?: string;
};

/**
 * Session indexer for Claude transcript artifacts.
 */
export class ClaudeSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'claude' as const;
  private readonly claudeHome = path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));

  /**
   * Returns true when a JSONL file is a subagent transcript or tool result
   * rather than a top-level session.
   *
   * Claude stores subagent transcripts under a `subagents/` directory and
   * tool results under a `tool-results/` directory, e.g.
   * `~/.claude/projects/<encoded-cwd>/<session-id>/subagents/agent-<id>.jsonl`.
   * Those files repeat the parent session's `sessionId`, so indexing them as
   * standalone sessions overwrites the parent row's `jsonl_path` and corrupts
   * the main session record. The recursive scan in `synchronize()` reaches
   * them, so both entry points must skip them.
   */
  private isSubagentTranscript(filePath: string): boolean {
    const pathParts = path.normalize(filePath).split(path.sep);
    return pathParts.includes('subagents') || pathParts.includes('tool-results');
  }

  /** Scan the default CLI store and DB-known canonical user histories, never profile aliases or arbitrary parent trees. */
  async synchronize(since?: Date): Promise<number> {
    const homes = [...await claudeHistoryRoots(), { home: this.claudeHome, userId: null }];
    const seen = new Set<string>();
    let processed = 0;
    for (const { home } of homes) {
      const files = await this.topLevelSessionFiles(home, since);
      for (const filePath of files) {
        const artifact = await resolveClaudeHistoryArtifact(filePath);
        if (!artifact || seen.has(artifact.filePath)) continue;
        seen.add(artifact.filePath);
        if (await this.synchronizeFile(artifact.filePath)) processed += 1;
      }
    }
    return processed;
  }

  /** Resolve aliases before indexing; a profile deletion must not strand a previously indexed conversation. */
  async synchronizeFile(filePath: string): Promise<string | null> {
    if (!filePath.endsWith('.jsonl') || this.isSubagentTranscript(filePath)) return null;
    const artifact = await resolveClaudeHistoryArtifact(filePath);
    if (!artifact) return null;
    const nameMap = await buildLookupMap(path.join(artifact.home, 'history.jsonl'), 'sessionId', 'display');
    const parsed = await this.processSessionFile(artifact.filePath, nameMap);
    if (!parsed || path.basename(artifact.filePath) !== `${parsed.sessionId}.jsonl`) return null;
    if (artifact.userId !== null) {
      // A forged transcript in one user's store cannot repoint another user's app row.
      const existing = sessionsDb.getSessionByProviderSessionId(parsed.sessionId) ?? sessionsDb.getSessionById(parsed.sessionId);
      if (existing?.jsonl_path) {
        const registered = await resolveClaudeHistoryArtifact(existing.jsonl_path);
        if (registered?.userId !== null && registered?.userId !== undefined && registered.userId !== artifact.userId) return null;
        // An explicit managed->default resume records its real destination; old central copies must not steal it back.
        if (registered?.userId === null && !this.sameArtifactPath(registered.filePath, artifact.filePath)) return null;
      }
      try { assertSshSessionAccess(existing?.session_id ?? parsed.sessionId, artifact.userId); }
      catch { return null; }
      if (!existing) {
        // New managed transcripts need durable workspace ownership; ambiguous legacy projects remain unclaimed.
        try { this.assertNewArtifactOwner(parsed.projectPath, artifact.userId); }
        catch { return null; }
      }
    } else {
      // Once imported, canonical per-user history wins over the old default copy on later full scans.
      const existing = sessionsDb.getSessionByProviderSessionId(parsed.sessionId) ?? sessionsDb.getSessionById(parsed.sessionId);
      if (existing?.jsonl_path) {
        const registered = await resolveClaudeHistoryArtifact(existing.jsonl_path);
        if (registered?.userId !== null && registered?.userId !== undefined) return null;
      }
    }
    const timestamps = await readFileTimestamps(artifact.filePath);
    return sessionsDb.createSession(parsed.sessionId, this.provider, parsed.projectPath, parsed.sessionName, timestamps.createdAt, timestamps.updatedAt, artifact.filePath);
  }

  private sameArtifactPath(left: string, right: string): boolean {
    return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
  }

  private async topLevelSessionFiles(home: string, since?: Date): Promise<string[]> {
    const projects = path.join(home, 'projects');
    const files: string[] = [];
    try {
      const root = await lstat(projects);
      if (!root.isDirectory() || root.isSymbolicLink()) return files;
      // Claude parents live exactly one encoded-cwd directory below projects.
      // Subagents/tool-results cannot be standalone sessions and need no recursive crawl.
      for (const folder of await readdir(projects, { withFileTypes: true })) {
        if (!folder.isDirectory() || folder.isSymbolicLink()) continue;
        for (const entry of await readdir(path.join(projects, folder.name), { withFileTypes: true })) {
          if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.jsonl')) continue;
          const filePath = path.join(projects, folder.name, entry.name);
          const metadata = await lstat(filePath);
          if (!since || metadata.birthtime > since || metadata.mtime > since) files.push(filePath);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return files;
  }

  private assertNewArtifactOwner(projectPath: string, userId: number): void {
    const target = resolveSshProjectTarget(projectPath);
    if (target) assertSshProjectOwner(target, userId);
    else assertCloudWorkspaceOwner(projectPath, userId, userDb.getActiveUserIds());
  }

  /**
   * Extracts session metadata from one Claude JSONL session file.
   */
  private async processSessionFile(
    filePath: string,
    nameMap: Map<string, string>
  ): Promise<ParsedSession | null> {
    const parsed = await extractFirstValidJsonlData(filePath, (rawData) => {
      const data = rawData as Record<string, unknown>;
      const sessionId = typeof data.sessionId === 'string' ? data.sessionId : undefined;
      const projectPath = typeof data.cwd === 'string' ? data.cwd : undefined;

      if (!sessionId || !projectPath) {
        return null;
      }

      return {
        sessionId,
        projectPath,
      };
    });

    if (!parsed) {
      return null;
    }

    // App-created sessions are keyed by an app id, so disk-discovered provider
    // ids must be resolved through the provider-id mapping first.
    const existingSession = sessionsDb.getSessionByProviderSessionId(parsed.sessionId)
      ?? sessionsDb.getSessionById(parsed.sessionId);
    const existingSessionName = existingSession?.custom_name;
    if (existingSessionName && existingSessionName !== 'Untitled Claude Session') {
      return {
        ...parsed,
        sessionName: normalizeSessionName(existingSessionName, 'Untitled Claude Session'),
      };
    }

    let sessionName = nameMap.get(parsed.sessionId);
    if (!sessionName) {
      sessionName = await this.extractSessionAiTitleFromEnd(filePath, parsed.sessionId);
    }

    return {
      ...parsed,
      sessionName: normalizeSessionName(sessionName, 'Untitled Claude Session'),
    };
  }

  private async extractSessionAiTitleFromEnd(
    filePath: string,
    sessionId: string
  ): Promise<string | undefined> {
    try {
      const content = await readFile(filePath, 'utf8');
      const lines = content.split(/\r?\n/);

      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index]?.trim();
        if (!line) {
          continue;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }

        const data = parsed as Record<string, unknown>;
        const eventType = typeof data.type === 'string' ? data.type : undefined;
        const eventSessionId = typeof data.sessionId === 'string' ? data.sessionId : undefined;
        const aiTitle = typeof data.aiTitle === 'string' ? data.aiTitle : undefined;
        const lastPrompt = typeof data.lastPrompt === 'string' ? data.lastPrompt : undefined;
        const claudeRenamedTitle = typeof data.customTitle === 'string' ? data.customTitle : undefined;

        if (
          (eventType === 'ai-title' && eventSessionId === sessionId && aiTitle?.trim()) ||
          (eventType === 'last-prompt' && eventSessionId === sessionId && lastPrompt?.trim()) ||
          (eventType === "custom-title" && eventSessionId === sessionId && claudeRenamedTitle?.trim())
        ) {
          return aiTitle || lastPrompt || claudeRenamedTitle;
        }
      }
    } catch {
      // Ignore missing/unreadable files so sync can continue.
    }

    return undefined;
  }
}
