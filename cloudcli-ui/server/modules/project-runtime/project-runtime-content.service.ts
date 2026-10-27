import path from 'node:path';

import { AppError, parseFrontMatter } from '@/shared/index.js';

type ContentFile = { content: string; hash: string };
type ContentSource = { path: string; hash: string; kind: 'instruction' | 'rule' | 'settings' | 'skill' };
type SkillMetadata = {
  name: string; description: string; path: string; hash: string; argumentHint?: string;
  userInvocable: boolean; disableModelInvocation: boolean; allowedTools: string[]; unsupported: string[];
};
type ContentDependencies = {
  read(relative: string): Promise<ContentFile | null>;
  list(relative: string): Promise<Array<{ name: string; directory: boolean }>>;
  assertCurrent(): void;
  signal?: AbortSignal;
};
type Rule = { path: string; body: string; patterns: string[] };
type Skill = { metadata: SkillMetadata; body: string };
const MAX_BYTES = 256 * 1024;
const MAX_FILES = 256;
const MAX_ENTRIES = 512;
const MAX_TREE_DEPTH = 8;
const MAX_IMPORT_DEPTH = 5;

function fail(code: string, message: string): never {
  throw new AppError(message, { code: `PROJECT_RUNTIME_${code}`, statusCode: code === 'SKILL_NOT_FOUND' ? 404 : 400 });
}

function relativePath(value: string, base = '', virtual = false): string {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u001f\u007f:]/.test(value)) fail('PATH_INVALID', 'Project content paths must remain inside the selected project.');
  let candidate = value.replace(/\\/g, '/');
  if (virtual && (candidate === '/workspace' || candidate.startsWith('/workspace/'))) candidate = candidate.slice('/workspace'.length).replace(/^\//, '');
  if (candidate.startsWith('/') || candidate.startsWith('~')) fail('PATH_INVALID', 'Absolute and user-home imports are unsupported.');
  const normalized = path.posix.normalize(path.posix.join(base, candidate));
  if (normalized === '..' || normalized.startsWith('../')) fail('PATH_INVALID', 'Project content paths cannot escape the selected project.');
  return normalized === '.' ? '' : normalized;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function safeData(value: unknown, depth = 0, seen = new Set<object>()): unknown {
  if (depth > 20) fail('LIMIT', 'Project configuration nesting exceeds 20 levels.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || seen.has(value)) fail('CONFIG_INVALID', 'Project configuration must contain finite JSON values without aliases or cycles.');
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => safeData(item, depth + 1, seen));
  if (!plainObject(value)) fail('CONFIG_INVALID', 'Project configuration must contain plain objects.');
  const entries = Object.entries(value);
  if (entries.length > 1000) fail('LIMIT', 'A project configuration object has too many keys.');
  return Object.fromEntries(entries.map(([key, item]) => {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('CONFIG_INVALID', 'Unsafe project configuration key.');
    return [key, safeData(item, depth + 1, seen)];
  }));
}

function mergeSettings(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) result[key] = plainObject(value) && plainObject(base[key]) ? mergeSettings(base[key], value) : value;
  return result;
}

function markdown(content: string, source: string) {
  const text = content.replace(/^\uFEFF/, '');
  if (text.startsWith('---') && !/^---(?:yaml)?\s*\r?\n/.test(text)) fail('CONFIG_INVALID', `Unsupported frontmatter format in ${source}.`);
  if (/^---(?:yaml)?\s*\r?\n/.test(text) && !/^---\s*$/m.test(text.slice(text.indexOf('\n') + 1))) fail('CONFIG_INVALID', `Unterminated frontmatter in ${source}.`);
  try {
    const parsed = parseFrontMatter(text);
    const data = safeData(parsed.data);
    if (!plainObject(data)) fail('CONFIG_INVALID', `Frontmatter in ${source} must be an object.`);
    return { body: parsed.content, data };
  } catch (error) {
    if (error instanceof AppError) throw error;
    fail('CONFIG_INVALID', `Malformed frontmatter in ${source}.`);
  }
}

function globPatterns(pattern: string): string[] {
  if (typeof pattern !== 'string' || !pattern || pattern.length > 512 || /[\\\u0000-\u001f:]/.test(pattern)
    || pattern.startsWith('/') || pattern.startsWith('~') || pattern.split('/').includes('..')) fail('CONFIG_INVALID', 'Rule paths must be bounded project-relative glob patterns.');
  let variants = [pattern.replace(/^\.\//, '')];
  for (let depth = 0; variants.some(value => value.includes('{')); depth++) {
    if (depth >= 4) fail('LIMIT', 'Rule glob brace nesting exceeds its limit.');
    variants = variants.flatMap(value => {
      const close = value.indexOf('}');
      if (close < 0) fail('CONFIG_INVALID', 'Malformed rule glob braces.');
      const open = value.lastIndexOf('{', close);
      if (open < 0) fail('CONFIG_INVALID', 'Malformed rule glob braces.');
      const options = value.slice(open + 1, close).split(',');
      if (options.length < 2 || options.some(option => !option)) fail('CONFIG_INVALID', 'Rule glob braces must contain alternatives.');
      return options.map(option => value.slice(0, open) + option + value.slice(close + 1));
    });
    if (variants.length > 32) fail('LIMIT', 'Rule glob alternatives exceed 32 patterns.');
  }
  for (const value of variants) {
    if (/[{}]/.test(value)) fail('CONFIG_INVALID', 'Malformed rule glob braces.');
    if (/[\[\]]/.test(value)) fail('CONFIG_INVALID', 'Rule character classes are unsupported; use glob braces instead.');
    if (value.split('/').some(segment => segment.includes('**') && segment !== '**')) fail('CONFIG_INVALID', 'Rule ** wildcards must occupy a complete path segment.');
  }
  return variants;
}

function matchSegment(pattern: string, value: string): boolean {
  // Wildcard matching uses bounded dynamic programming rather than constructing
  // regular expressions from project input (which could backtrack exponentially).
  let previous = Array.from({ length: value.length + 1 }, (_, index) => index === 0);
  for (const char of pattern) {
    const current = Array<boolean>(value.length + 1).fill(false);
    if (char === '*') current[0] = previous[0];
    for (let index = 1; index <= value.length; index++) current[index] = char === '*'
      ? previous[index] || current[index - 1] : previous[index - 1] && (char === '?' || char === value[index - 1]);
    previous = current;
  }
  return previous[value.length];
}

function matchesGlob(pattern: string, relative: string): boolean {
  const expected = pattern.split('/');
  const actual = relative.split('/');
  const memo = new Map<string, boolean>();
  function visit(left: number, right: number): boolean {
    const key = `${left}:${right}`;
    if (memo.has(key)) return memo.get(key)!;
    const result = left === expected.length ? right === actual.length : expected[left] === '**'
      ? visit(left + 1, right) || right < actual.length && visit(left, right + 1)
      : right < actual.length && matchSegment(expected[left], actual[right]) && visit(left + 1, right + 1);
    memo.set(key, result);
    return result;
  }
  return visit(0, 0);
}

function textField(data: Record<string, unknown>, key: string, source: string): string | undefined {
  if (data[key] === undefined) return undefined;
  if (typeof data[key] !== 'string' || (data[key] as string).length > 8192) fail('CONFIG_INVALID', `${source}: ${key} must be bounded text.`);
  return data[key] as string;
}

function boolField(data: Record<string, unknown>, key: string, fallback: boolean, source: string): boolean {
  if (data[key] === undefined) return fallback;
  if (typeof data[key] !== 'boolean') fail('CONFIG_INVALID', `${source}: ${key} must be a boolean.`);
  return data[key] as boolean;
}

function argumentTokens(args: string): string[] {
  const tokens: string[] = [];
  let token = '', quote = '', started = false;
  for (const char of args) {
    if (quote) { if (char === quote) quote = ''; else token += char; started = true; }
    else if (char === '"' || char === "'") { quote = char; started = true; }
    else if (/\s/.test(char)) { if (started) { tokens.push(token); token = ''; started = false; } }
    else { token += char; started = true; }
  }
  if (quote) fail('CONFIG_INVALID', 'Skill arguments contain an unterminated quote.');
  if (started) tokens.push(token);
  if (tokens.length > 100) fail('LIMIT', 'Skill invocation has too many arguments.');
  return tokens;
}

/** Project-runtime composition injects its owner/generation-pinned virtual filesystem; this resolver never reads host files, invokes tools, or grants permissions. PROJECT_RUNTIME_* errors fail explicit malformed/unsafe input rather than silently dropping it. */
export function createProjectContentResolver(dependencies: ContentDependencies) {
  const files = new Map<string, ContentFile | null>();
  const sources = new Map<string, ContentSource>();
  const warnings = new Set<string>();
  let bytes = 0, entries = 0, listings = 0;
  let snapshot: Promise<{ instructions: string; projectSettings: Record<string, unknown>; localSettings: Record<string, unknown>;
    settings: Record<string, unknown>; skills: Map<string, Skill>; rules: Rule[] }> | undefined;

  function check() { dependencies.signal?.throwIfAborted(); dependencies.assertCurrent(); }
  async function read(candidate: string, kind: ContentSource['kind']): Promise<ContentFile | null> {
    check();
    const relative = relativePath(candidate);
    if (!files.has(relative)) {
      if (files.size >= MAX_FILES) fail('LIMIT', 'Project content discovery exceeds 256 files.');
      let value: ContentFile | null;
      try { value = await dependencies.read(relative); }
      catch (error) { check(); if ((error as { code?: string }).code === 'ENOENT') value = null; else throw error; }
      check();
      if (value !== null) {
        if (!value || typeof value.content !== 'string' || typeof value.hash !== 'string' || !value.hash || value.hash.length > 256) fail('CONFIG_INVALID', `Invalid project content response for ${relative}.`);
        bytes += Buffer.byteLength(value.content, 'utf8');
        if (bytes > MAX_BYTES) fail('LIMIT', 'Project content exceeds the 256 KiB aggregate limit.');
        value = { content: value.content.replace(/^\uFEFF/, ''), hash: value.hash };
      }
      files.set(relative, value);
    }
    const value = files.get(relative)!;
    if (value) sources.set(`${kind}:${relative}`, { path: relative, hash: value.hash, kind });
    check();
    return value;
  }
  async function list(candidate: string) {
    check();
    const relative = relativePath(candidate);
    if (++listings > 128) fail('LIMIT', 'Project content discovery exceeds 128 directories.');
    let rows: Array<{ name: string; directory: boolean }>;
    try { rows = await dependencies.list(relative); }
    catch (error) { check(); if ((error as { code?: string }).code === 'ENOENT') rows = []; else throw error; }
    check();
    if (!Array.isArray(rows) || (entries += rows.length) > MAX_ENTRIES) fail('LIMIT', 'Project content discovery exceeds 512 directory entries.');
    const names = new Set<string>();
    for (const row of rows) {
      if (!row || typeof row.name !== 'string' || !row.name || row.name === '.' || row.name === '..' || /[/\\\u0000-\u001f:]/.test(row.name)
        || typeof row.directory !== 'boolean' || names.has(row.name)) fail('PATH_INVALID', 'Project content directory contains an invalid or duplicate entry.');
      names.add(row.name);
    }
    return [...rows].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  }

  async function instruction(relative: string, kind: ContentSource['kind'], seen: Set<string>, stack: string[] = []): Promise<string> {
    check();
    const canonical = relativePath(relative);
    if (stack.includes(canonical)) fail('IMPORT_CYCLE', `Project instruction import cycle: ${[...stack, canonical].join(' -> ')}.`);
    if (stack.length > MAX_IMPORT_DEPTH) fail('LIMIT', 'Project instruction imports exceed depth 5.');
    if (seen.has(canonical)) return '';
    const file = await read(canonical, kind);
    if (!file) { if (stack.length) fail('IMPORT_MISSING', `Project instruction import is missing: ${canonical}.`); return ''; }
    seen.add(canonical);
    const { body } = markdown(file.content, canonical);
    if (/!`[^`]+`/.test(body)) warnings.add(`${canonical}: dynamic shell substitutions are left as text and never executed.`);
    let fenced = false;
    const output: string[] = [];
    for (const line of body.split('\n')) {
      check();
      if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; output.push(line); continue; }
      if (fenced) { output.push(line); continue; }
      // Mask inline code so examples and email addresses do not become imports.
      const visible = line.replace(/`[^`]*`/g, match => ' '.repeat(match.length));
      const imports = [...visible.matchAll(/(^|[\s(])@(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s)<>]+))/g)];
      let cursor = 0, expanded = '';
      for (const item of imports) {
        const tokenStart = item.index! + item[1].length;
        const tokenEnd = item.index! + item[0].length;
        expanded += line.slice(cursor, tokenStart);
        const target = relativePath(item[2] ?? item[3] ?? item[4], path.posix.dirname(canonical));
        expanded += await instruction(target, kind, seen, [...stack, canonical]);
        cursor = tokenEnd;
      }
      output.push(expanded + line.slice(cursor));
    }
    const result = `[Project instructions: /workspace/${canonical}]\n${output.join('\n').trim()}`;
    if (Buffer.byteLength(result) > MAX_BYTES) fail('LIMIT', 'Expanded project instructions exceed 256 KiB.');
    return result;
  }

  async function settings(relative: string) {
    const file = await read(relative, 'settings');
    if (!file) return {};
    let parsed: unknown;
    try { parsed = safeData(JSON.parse(file.content)); }
    catch (error) { if (error instanceof AppError) throw error; fail('CONFIG_INVALID', `Malformed JSON in ${relative}.`); }
    if (!plainObject(parsed)) fail('CONFIG_INVALID', `${relative} must contain a JSON object.`);
    if (parsed.hooks !== undefined) warnings.add(`${relative}: hooks are unsupported and will not execute.`);
    return parsed;
  }

  async function build() {
    const seen = new Set<string>();
    const parts: string[] = [];
    for (const relative of ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md']) {
      const body = await instruction(relative, 'instruction', seen);
      if (body) parts.push(body);
    }
    const projectSettings = await settings('.claude/settings.json');
    const localSettings = await settings('.claude/settings.local.json');
    const rules: Rule[] = [];
    async function discoverRules(directory: string, depth: number): Promise<void> {
      if (depth > MAX_TREE_DEPTH) fail('LIMIT', 'Project rules exceed directory depth 8.');
      for (const entry of await list(directory)) {
        const relative = relativePath(entry.name, directory);
        if (entry.directory) await discoverRules(relative, depth + 1);
        else if (entry.name.toLowerCase().endsWith('.md')) {
          const file = await read(relative, 'rule');
          if (!file) fail('CONFIG_INVALID', `Project rule disappeared during discovery: ${relative}.`);
          const parsed = markdown(file.content, relative);
          const configured = parsed.data.paths;
          const values = configured === undefined ? [] : typeof configured === 'string' ? [configured] : configured;
          if (!Array.isArray(values) || configured !== undefined && values.length === 0 || values.some(value => typeof value !== 'string')) fail('CONFIG_INVALID', `${relative}: paths must be text or a nonempty list of glob patterns.`);
          if (values.length > 64) fail('LIMIT', `${relative}: too many rule patterns.`);
          const patterns = values.flatMap(value => globPatterns(value as string));
          if (patterns.length > 128 || rules.reduce((total, rule) => total + rule.patterns.length, patterns.length) > 512) fail('LIMIT', 'Project scoped rules exceed their glob-pattern budget.');
          const body = await instruction(relative, 'rule', patterns.length ? new Set() : seen);
          if (patterns.length) rules.push({ path: relative, body, patterns }); else if (body) parts.push(body);
        }
      }
    }
    await discoverRules('.claude/rules', 0);
    const skills = new Map<string, Skill>();
    async function discoverSkills(directory: string, depth: number): Promise<void> {
      if (depth > MAX_TREE_DEPTH) fail('LIMIT', 'Project skills exceed directory depth 8.');
      const children = await list(directory);
      if (children.some(entry => !entry.directory && entry.name === 'SKILL.md')) {
        if (skills.size >= 100) fail('LIMIT', 'Project skill discovery exceeds 100 skills.');
        const relative = `${directory}/SKILL.md`;
        const file = await read(relative, 'skill');
        if (!file) fail('CONFIG_INVALID', `Project skill disappeared during discovery: ${relative}.`);
        const parsed = markdown(file.content, relative);
        const name = textField(parsed.data, 'name', relative) ?? path.posix.basename(directory);
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) fail('CONFIG_INVALID', `${relative}: skill name must be a bounded command identifier.`);
        if (skills.has(name.toLowerCase())) fail('CONFIG_INVALID', `Project skill name is duplicated: ${name}.`);
        const unsupported = ['context', 'agent', 'hooks', 'model'].filter(key => parsed.data[key] !== undefined);
        const recognized = new Set(['name', 'description', 'argument-hint', 'user-invocable', 'disable-model-invocation', 'allowed-tools', 'context', 'agent', 'hooks', 'model']);
        for (const key of Object.keys(parsed.data)) if (!recognized.has(key)) warnings.add(`${relative}: unsupported skill metadata ${key} is not applied.`);
        if (/!`[^`]+`/.test(parsed.body)) unsupported.push('dynamic shell substitution');
        if (/\$\{CLAUDE_SESSION_ID\}/.test(parsed.body)) unsupported.push('CLAUDE_SESSION_ID substitution');
        const allowed = parsed.data['allowed-tools'];
        const allowedTools = allowed === undefined ? [] : typeof allowed === 'string' ? allowed.split(/[,\s]+/).filter(Boolean) : allowed;
        if (!Array.isArray(allowedTools) || allowedTools.length > 64 || allowedTools.some(value => typeof value !== 'string' || value.length > 256)) fail('CONFIG_INVALID', `${relative}: allowed-tools must be bounded tool names.`);
        if (allowedTools.length) warnings.add(`${relative}: allowed-tools is metadata only and never grants approval.`);
        if (unsupported.length) warnings.add(`${relative}: unsupported skill features: ${unsupported.join(', ')}; activation is blocked.`);
        const metadata: SkillMetadata = { name, description: textField(parsed.data, 'description', relative) ?? '', path: relative, hash: file.hash,
          argumentHint: textField(parsed.data, 'argument-hint', relative), userInvocable: boolField(parsed.data, 'user-invocable', true, relative),
          disableModelInvocation: boolField(parsed.data, 'disable-model-invocation', false, relative), allowedTools: allowedTools as string[], unsupported };
        skills.set(name.toLowerCase(), { metadata, body: parsed.body });
        // Resources stay in this skill directory and are read explicitly through
        // the existing pinned workspace file tools; do not scan their contents.
        return;
      }
      for (const entry of children) if (entry.directory) await discoverSkills(relativePath(entry.name, directory), depth + 1);
    }
    await discoverSkills('.claude/skills', 0);
    check();
    const instructions = parts.join('\n\n');
    if (Buffer.byteLength(instructions) + rules.reduce((total, rule) => total + Buffer.byteLength(rule.body), 0) > MAX_BYTES) fail('LIMIT', 'Expanded project content exceeds 256 KiB.');
    return { instructions, projectSettings, localSettings, settings: mergeSettings(projectSettings, localSettings), skills, rules };
  }

  async function load() { check(); snapshot ??= build(); const result = await snapshot; check(); return result; }
  async function activate(name: string, args: string, userInvocation: boolean) {
    check();
    if (typeof name !== 'string' || name.length > 65 || typeof args !== 'string' || Buffer.byteLength(args) > 32 * 1024) fail('LIMIT', 'Skill invocation arguments exceed their limit.');
    const state = await load();
    const skill = state.skills.get(name.replace(/^\//, '').toLowerCase());
    if (!skill) fail('SKILL_NOT_FOUND', 'The selected project skill does not exist.');
    if (skill.metadata.unsupported.length || userInvocation && !skill.metadata.userInvocable || !userInvocation && skill.metadata.disableModelInvocation) {
      fail('SKILL_UNSUPPORTED', `${skill.metadata.name}: unsupported activation (${skill.metadata.unsupported.join(', ') || (userInvocation ? 'user-invocable is false' : 'disable-model-invocation is true')}).`);
    }
    const positional = argumentTokens(args);
    const hasArguments = /\$ARGUMENTS(?:\[\d+\])?|\$\d+/.test(skill.body);
    const resources = `/workspace/${path.posix.dirname(skill.metadata.path)}`;
    let expandedBytes = Buffer.byteLength(skill.body);
    // Enforce the limit while replacing, before String.replace can allocate an
    // unbounded repeated-arguments result; never substitute inside user arguments.
    let body = skill.body.replace(/\$ARGUMENTS(?:\[\d+\])?|\$\d+|\$\{CLAUDE_SKILL_DIR\}/g, token => {
      const index = Number(token.startsWith('$ARGUMENTS[') ? token.slice(11, -1) : token.slice(1));
      const replacement = token === '${CLAUDE_SKILL_DIR}' ? resources : token === '$ARGUMENTS' ? args : positional[index] ?? '';
      expandedBytes += Buffer.byteLength(replacement) - Buffer.byteLength(token);
      if (expandedBytes > MAX_BYTES) fail('LIMIT', 'Expanded skill instructions exceed 256 KiB.');
      return replacement;
    });
    if (!hasArguments && args) body += `\n\nArguments: ${args}`;
    body += `\n\nSkill resources: ${resources}. Read relative resources through the project workspace file tools. Tool approvals remain governed by the current session.`;
    if (Buffer.byteLength(body) > MAX_BYTES) fail('LIMIT', 'Expanded skill instructions exceed 256 KiB.');
    check();
    return { name: skill.metadata.name, path: skill.metadata.path, hash: skill.metadata.hash, body };
  }

  return {
    async resolve(input: { prompt?: string } = {}) {
      const state = await load();
      let instructions = state.instructions;
      const command = typeof input.prompt === 'string' ? /^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(input.prompt.trim()) : null;
      if (command && state.skills.has(command[1].toLowerCase())) instructions += `\n\n${(await activate(command[1], command[2] ?? '', true)).body}`;
      if (Buffer.byteLength(instructions) > MAX_BYTES) fail('LIMIT', 'Expanded project instructions exceed 256 KiB.');
      check();
      return { sources: [...sources.values()].map(source => ({ ...source })), instructions,
        projectSettings: safeData(state.projectSettings) as Record<string, unknown>, localSettings: safeData(state.localSettings) as Record<string, unknown>,
        settings: safeData(state.settings) as Record<string, unknown>, skills: [...state.skills.values()].map(skill => ({ ...skill.metadata,
          allowedTools: [...skill.metadata.allowedTools], unsupported: [...skill.metadata.unsupported] })), warnings: [...warnings] };
    },
    async activateSkill(name: string, args = '') { return activate(name, args, false); },
    async rulesForPath(candidate: string) {
      check();
      const relative = relativePath(candidate, '', true);
      const state = await load();
      const result = state.rules.filter(rule => rule.patterns.some(pattern => matchesGlob(pattern, relative))).map(rule => rule.body).join('\n\n');
      check();
      return result;
    },
  };
}
