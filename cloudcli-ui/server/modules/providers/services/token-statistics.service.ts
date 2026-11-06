import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

import Database from 'better-sqlite3';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { AppError, getOpenCodeDatabasePath } from '@/shared/index.js';
import { resolveProviderHome } from '@/modules/providers/services/provider-state.service.js';
import { canReadSshSession } from '@/modules/providers/services/ssh-session-access.service.js';

type Session = NonNullable<ReturnType<typeof sessionsDb.getSessionById>>;
type Range = 'today' | '7d' | '30d' | 'all';
type Counts = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number };
type Usage = Counts & { keys: string[]; at: number; model: string };
type Parsed = { records: Usage[]; incomplete: boolean; unsupported?: boolean };
type Dependencies = {
  listSessions: () => Session[];
  canReadSession: (sessionId: string, userId: string | number) => boolean;
  getSupersededTranscriptPaths: (sessionId: string) => string[];
  projectName: (projectPath: string) => string | null;
  now: () => Date;
  canonicalPath: (file: string) => Promise<string>;
  statFile: (file: string) => Promise<{ size: number; mtimeMs: number }>;
  readLines: (file: string, maxBytes: number) => AsyncIterable<string>;
  openCodeDatabasePath: (session: Session) => string;
  maxFileBytes: number;
  maxRecordsPerFile: number;
  maxReportRecords: number;
  maxCacheRecords: number;
  maxCacheFiles: number;
};

const defaults: Dependencies = {
  listSessions: () => [...sessionsDb.getAllSessions(), ...sessionsDb.getArchivedSessions()],
  canReadSession: canReadSshSession,
  getSupersededTranscriptPaths: (id) => sessionsDb.getSupersededTranscriptPaths(id),
  projectName: (projectPath) => projectsDb.getProjectPath(projectPath)?.custom_project_name ?? null,
  now: () => new Date(),
  canonicalPath: realpath,
  statFile: stat,
  async *readLines(file, maxBytes) {
    const stream = createReadStream(file, { encoding: 'utf8', start: 0, end: maxBytes - 1 });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try { for await (const line of lines) yield line; }
    finally { lines.close(); stream.destroy(); }
  },
  openCodeDatabasePath: (session) => session.provider_profile_path
    ? path.join(resolveProviderHome('opencode', session.session_id, session.provider_profile_path), '.local', 'share', 'opencode', 'opencode.db')
    : getOpenCodeDatabasePath(),
  maxFileBytes: 64 * 1024 * 1024,
  maxRecordsPerFile: 20_000,
  maxReportRecords: 100_000,
  maxCacheRecords: 20_000,
  maxCacheFiles: 32,
};

function object(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null;
}
function string(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : null;
}
function token(value: unknown, optional = false): number | null {
  if (value === undefined && optional) return 0;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function timestamp(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 8.64e15 ? parsed : null;
}
function counts(input: unknown, output: unknown, read?: unknown, creation?: unknown): Counts | null {
  const values = [token(input), token(output), token(read, true), token(creation, true)];
  if (values.some((value) => value === null)) return null;
  return { inputTokens: values[0]!, outputTokens: values[1]!, cacheReadTokens: values[2]!, cacheCreationTokens: values[3]! };
}
function total(value: Counts): number {
  return value.inputTokens + value.outputTokens + value.cacheReadTokens + value.cacheCreationTokens;
}
function emptyTotals() {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0, requests: 0 };
}
function add(target: ReturnType<typeof emptyTotals>, value: Counts) {
  target.inputTokens += value.inputTokens;
  target.outputTokens += value.outputTokens;
  target.cacheReadTokens += value.cacheReadTokens;
  target.cacheCreationTokens += value.cacheCreationTokens;
  target.totalTokens += total(value);
  target.requests += 1;
}

// Streaming chunks and fork copies describe one billed request. Preserve the
// largest final counters and the newest timestamp, never add chunk snapshots.
function merge(target: Usage, incoming: Usage) {
  for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens'] as const) {
    target[field] = Math.max(target[field], incoming[field]);
  }
  if (incoming.at >= target.at) {
    target.at = incoming.at;
    if (incoming.model !== 'unknown') target.model = incoming.model;
  }
  target.keys = [...new Set([...target.keys, ...incoming.keys])].slice(0, 8);
}

async function parseTranscript(file: string, provider: string, dependencies: Dependencies): Promise<Parsed> {
  const records = new Map<string, Usage>();
  const aliases = new Map<string, Usage>();
  let incomplete = false;
  let model = 'unknown';
  let previous = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  let lines = 0;
  for await (const line of dependencies.readLines(file, dependencies.maxFileBytes)) {
    lines += 1;
    if (!line.trim()) continue;
    if (line.length > 2 * 1024 * 1024) { incomplete = true; continue; }
    let entry: Record<string, any>;
    try { entry = object(JSON.parse(line))!; }
    catch { incomplete = true; continue; }
    if (!entry) { incomplete = true; continue; }
    let usage: Usage | null = null;
    if (provider === 'claude') {
      if (entry.type !== 'assistant') continue;
      const message = object(entry.message);
      if (message?.model === '<synthetic>' || entry.isSynthetic === true) continue;
      const raw = object(message?.usage);
      if (!raw) { incomplete = true; continue; }
      const value = counts(raw.input_tokens ?? raw.inputTokens, raw.output_tokens ?? raw.outputTokens,
        raw.cache_read_input_tokens ?? raw.cacheReadInputTokens ?? raw.cacheReadTokens,
        raw.cache_creation_input_tokens ?? raw.cacheCreationInputTokens ?? raw.cacheCreationTokens);
      const messageId = string(message?.id);
      const requestId = string(entry.requestId ?? entry.request_id ?? message?.requestId ?? message?.request_id);
      const at = timestamp(entry.timestamp ?? message?.timestamp);
      if (!value || at === null || (!messageId && !requestId)) { incomplete = true; continue; }
      usage = { ...value, at, model: string(message?.model) ?? 'unknown', keys: [
        ...(messageId ? [`claude:message:${messageId}`] : []),
        ...(requestId ? [`claude:request:${requestId}`] : []),
      ] };
    } else {
      if (entry.type === 'turn_context') model = string(entry.payload?.model) ?? model;
      if (entry.type !== 'event_msg' || entry.payload?.type !== 'token_count') continue;
      const raw = object(entry.payload.info?.total_token_usage);
      // A last_token_usage snapshot alone cannot distinguish a repeated event
      // from another request. Keep it unavailable rather than invent a delta.
      if (!raw) { incomplete = true; continue; }
      const cumulative = counts(raw.input_tokens, raw.output_tokens, raw.cached_input_tokens);
      if (!cumulative || cumulative.cacheReadTokens > cumulative.inputTokens) { incomplete = true; continue; }
      if (cumulative.inputTokens < previous.inputTokens || cumulative.outputTokens < previous.outputTokens
        || cumulative.cacheReadTokens < previous.cacheReadTokens) incomplete = true;
      const input = Math.max(0, cumulative.inputTokens - previous.inputTokens);
      const cached = Math.max(0, cumulative.cacheReadTokens - previous.cacheReadTokens);
      const output = Math.max(0, cumulative.outputTokens - previous.outputTokens);
      previous = {
        inputTokens: Math.max(previous.inputTokens, cumulative.inputTokens),
        outputTokens: Math.max(previous.outputTokens, cumulative.outputTokens),
        cacheReadTokens: Math.max(previous.cacheReadTokens, cumulative.cacheReadTokens), cacheCreationTokens: 0,
      };
      if (input === 0 && output === 0 && cached === 0) continue;
      const at = timestamp(entry.timestamp);
      if (at === null || cached > input) { incomplete = true; continue; }
      // Original timestamps/counters survive native fork copies and aliases.
      usage = { inputTokens: input - cached, outputTokens: output, cacheReadTokens: cached, cacheCreationTokens: 0,
        at, model, keys: [`codex:${at}:${raw.input_tokens}:${raw.cached_input_tokens ?? 0}:${raw.output_tokens}`] };
    }
    const matches = [...new Set(usage.keys.map((key) => aliases.get(key)).filter((match): match is Usage => Boolean(match)))];
    const existing = matches[0];
    if (existing) {
      // A final record can bridge an earlier message-only record and a
      // request-only record. Union both instead of retaining two requests.
      for (const duplicate of matches.slice(1)) {
        merge(existing, duplicate);
        records.delete(duplicate.keys[0]);
        for (const [alias, target] of aliases) if (target === duplicate) aliases.set(alias, existing);
      }
      merge(existing, usage);
      for (const key of existing.keys) aliases.set(key, existing);
    } else {
      if (records.size >= dependencies.maxRecordsPerFile || aliases.size >= dependencies.maxRecordsPerFile * 4) {
        incomplete = true;
        break;
      }
      records.set(usage.keys[0], usage);
      for (const key of usage.keys) aliases.set(key, usage);
    }
  }
  return { records: [...records.values()], incomplete: incomplete || lines === 0 };
}

function readOpenCode(session: Session, dependencies: Dependencies): Parsed {
  const database = new Database(dependencies.openCodeDatabasePath(session), { readonly: true, fileMustExist: true });
  try {
    const columns = database.prepare('PRAGMA table_info(message)').all() as { name: string }[];
    if (!['id', 'session_id', 'time_created', 'data'].every((name) => columns.some((column) => column.name === name))) {
      return { records: [], incomplete: true, unsupported: true };
    }
    const records: Usage[] = [];
    let incomplete = false;
    const rows = database.prepare('SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id LIMIT ?')
      .iterate(session.provider_session_id ?? session.session_id, dependencies.maxRecordsPerFile + 1);
    let scanned = 0;
    for (const raw of rows) {
      scanned += 1;
      if (scanned > dependencies.maxRecordsPerFile) { incomplete = true; break; }
      const row = raw as { id: string; time_created: number; data: string };
      if (typeof row.data !== 'string' || row.data.length > 2 * 1024 * 1024) { incomplete = true; continue; }
      let info: Record<string, any> | null;
      try { info = object(JSON.parse(row.data)); }
      catch { incomplete = true; continue; }
      if (info?.role !== 'assistant') continue;
      const rawTokens = object(info.tokens);
      const value = rawTokens && counts(rawTokens.input, rawTokens.output, rawTokens.cache?.read, rawTokens.cache?.write);
      const reasoning = token(rawTokens?.reasoning, true);
      const at = timestamp(info.time?.created ?? row.time_created);
      if (!value || reasoning === null || at === null || !string(row.id)) { incomplete = true; continue; }
      records.push({ ...value, outputTokens: value.outputTokens + reasoning, at,
        model: string(info.modelID) ?? 'unknown', keys: [`opencode:message:${row.id}`] });
    }
    return { records, incomplete };
  } finally { database.close(); }
}

/** Provider routes consume this factory's singleton; provider tests inject isolated owned-session and file fixtures. */
export function createTokenStatisticsService(overrides: Partial<Dependencies> = {}) {
  const dependencies = { ...defaults, ...overrides };
  const cache = new Map<string, { identity: string; value: Parsed }>();
  let cachedRecords = 0;

  async function readTranscript(file: string, provider: string): Promise<Parsed> {
    const canonical = await dependencies.canonicalPath(file);
    const before = await dependencies.statFile(canonical);
    const key = `${provider}:${canonical}`;
    const identity = `${before.size}:${before.mtimeMs}`;
    const cached = cache.get(key);
    if (cached?.identity === identity) {
      cache.delete(key); cache.set(key, cached);
      return cached.value;
    }
    if (cached) { cachedRecords -= cached.value.records.length; cache.delete(key); }
    const value = await parseTranscript(canonical, provider, dependencies);
    if (before.size > dependencies.maxFileBytes) value.incomplete = true;
    const after = await dependencies.statFile(canonical);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      value.incomplete = true;
      return value;
    }
    if (value.records.length <= dependencies.maxCacheRecords) {
      while (cache.size && (cache.size >= dependencies.maxCacheFiles || cachedRecords + value.records.length > dependencies.maxCacheRecords)) {
        const oldest = cache.keys().next().value!;
        cachedRecords -= cache.get(oldest)!.value.records.length; cache.delete(oldest);
      }
      if (dependencies.maxCacheFiles > 0) { cache.set(key, { identity, value }); cachedRecords += value.records.length; }
    }
    return value;
  }

  return {
    async getStatistics(input: { userId: string | number | null | undefined; range: Range; timeZone: string; sessionId?: string }) {
      if (input.userId === null || input.userId === undefined || input.userId === '' || input.userId === 0) {
        throw new AppError('Authentication required.', { code: 'UNAUTHORIZED', statusCode: 401 });
      }
      const now = dependencies.now();
      const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: input.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
      const day = (at: number) => {
        const parts = formatter.formatToParts(new Date(at));
        return ['year', 'month', 'day'].map((name) => parts.find((part) => part.type === name)!.value).join('-');
      };
      const today = day(now.getTime());
      const days = input.range === 'today' ? 1 : input.range === '7d' ? 7 : 30;
      const from = input.range === 'all' ? '' : new Date(Date.parse(`${today}T00:00:00Z`) - (days - 1) * 86_400_000).toISOString().slice(0, 10);
      const indexed = [...new Map(dependencies.listSessions().map((session) => [session.session_id, session])).values()];
      if (input.sessionId) {
        const target = indexed.find((session) => session.session_id === input.sessionId);
        if (!target) throw new AppError('Session not found.', { code: 'SESSION_NOT_FOUND', statusCode: 404 });
        if (!dependencies.canReadSession(target.session_id, input.userId)) {
          throw new AppError('Session access denied.', { code: 'SESSION_FORBIDDEN', statusCode: 403 });
        }
      }
      // Authorization precedes transcript paths, filesystem/cache reads and all coverage counts.
      const sessions = indexed.filter((session) => (!input.sessionId || session.session_id === input.sessionId)
        && dependencies.canReadSession(session.session_id, input.userId!));
      const coverage = { indexedSessions: sessions.length, measuredSessions: 0, unavailableSessions: 0, unsupportedSessions: 0 };
      const unique = new Map<string, { usage: Usage; session: Session }>();
      const aliases = new Map<string, string>();
      for (const session of sessions) {
        if (!['claude', 'codex', 'opencode'].includes(session.provider)) { coverage.unsupportedSessions += 1; continue; }
        let measured = false;
        let unavailable = false;
        let unsupported = false;
        let files: string[] = [];
        if (session.provider !== 'opencode') {
          try { files = [...new Set([session.jsonl_path, ...dependencies.getSupersededTranscriptPaths(session.session_id)].filter((file): file is string => Boolean(file)))]; }
          catch { unavailable = true; }
          // A never-started app placeholder has no consumed history to recover.
          if (!unavailable && files.length === 0 && !session.provider_session_id) continue;
          if (files.length === 0) unavailable = true;
        }
        // Process one generation at a time, so retired files cannot accumulate
        // unbounded parsed arrays before the account-level limit is enforced.
        for (const file of session.provider === 'opencode' ? [''] : files) {
          let result: Parsed;
          try { result = session.provider === 'opencode' ? readOpenCode(session, dependencies) : await readTranscript(file, session.provider); }
          catch { unavailable = true; continue; }
          unavailable ||= result.incomplete;
          unsupported ||= result.unsupported === true;
          for (const record of result.records) {
            if (record.at > now.getTime()) continue;
            measured = true;
            const matchingKeys = [...new Set(record.keys.map((key) => aliases.get(key)).filter((key): key is string => Boolean(key)))];
            const existingKey = matchingKeys[0];
            if (existingKey) {
              const existing = unique.get(existingKey)!;
              for (const duplicateKey of matchingKeys.slice(1)) {
                const duplicate = unique.get(duplicateKey)!;
                merge(existing.usage, duplicate.usage);
                if (existing.session.forked_from_session_id === duplicate.session.session_id) existing.session = duplicate.session;
                unique.delete(duplicateKey);
                for (const [alias, target] of aliases) if (target === duplicateKey) aliases.set(alias, existingKey);
              }
              merge(existing.usage, record);
              for (const key of existing.usage.keys) aliases.set(key, existingKey);
              // Attribute inherited fork history to its original indexed session.
              if (existing.session.forked_from_session_id === session.session_id) existing.session = session;
              continue;
            }
            if (unique.size >= dependencies.maxReportRecords || aliases.size >= dependencies.maxReportRecords * 4) { unavailable = true; continue; }
            const key = record.keys[0];
            unique.set(key, { usage: { ...record, keys: [...record.keys] }, session });
            for (const alias of record.keys) aliases.set(alias, key);
          }
        }
        if (measured) coverage.measuredSessions += 1;
        if (unsupported) coverage.unsupportedSessions += 1;
        if (unavailable || (!measured && !unsupported)) coverage.unavailableSessions += 1;
      }
      const totals = { ...emptyTotals(), sessions: 0 };
      const daily = new Map<string, ReturnType<typeof emptyTotals> & { date: string }>();
      const byModel = new Map<string, ReturnType<typeof emptyTotals> & { model: string; provider: string }>();
      const bySession = new Map<string, ReturnType<typeof emptyTotals> & { sessionId: string; title: string; projectName: string; provider: string; isArchived: boolean }>();
      for (const { usage, session } of unique.values()) {
        const date = day(usage.at);
        if (date < from || date > today) continue;
        const model = usage.model === 'unknown' ? session.model ?? 'unknown' : usage.model;
        const modelKey = JSON.stringify([session.provider, model]);
        if (!daily.has(date)) daily.set(date, { date, ...emptyTotals() });
        if (!byModel.has(modelKey)) byModel.set(modelKey, { model, provider: session.provider, ...emptyTotals() });
        if (!bySession.has(session.session_id)) bySession.set(session.session_id, {
          sessionId: session.session_id, title: session.custom_name || session.session_id,
          projectName: (session.project_path ? dependencies.projectName(session.project_path) : null)
            ?? session.project_path?.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? '',
          provider: session.provider, isArchived: Boolean(session.isArchived), ...emptyTotals(),
        });
        add(totals, usage); add(daily.get(date)!, usage); add(byModel.get(modelKey)!, usage); add(bySession.get(session.session_id)!, usage);
      }
      totals.sessions = bySession.size;
      return { range: input.range, timeZone: input.timeZone, sessionId: input.sessionId ?? null, generatedAt: now.toISOString(), totals,
        daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
        byModel: [...byModel.values()].sort((a, b) => b.totalTokens - a.totalTokens || a.model.localeCompare(b.model)),
        bySession: [...bySession.values()].sort((a, b) => b.totalTokens - a.totalTokens || a.sessionId.localeCompare(b.sessionId)), coverage };
    },
  };
}

/** Provider HTTP routes use this bounded, process-local cache of recorded cumulative usage. */
export const tokenStatisticsService = createTokenStatisticsService();
