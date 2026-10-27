import { isIP } from 'node:net';

type Source = 'accountSettings' | 'projectSettings' | 'localSettings' | 'accountMcp' | 'projectMcp';
type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'dontAsk' | 'bypassPermissions';
type Input = {
  accountSettings?: unknown;
  projectSettings?: unknown;
  localSettings?: unknown;
  accountMcp?: unknown;
  projectMcp?: unknown;
  sessionPermissionMode?: string;
  readOnly?: boolean;
  /** Only the selected account's explicitly supplied environment participates; process.env is never read. */
  env?: Record<string, string | undefined>;
};
type Warning = { source: Source | 'session'; code: string; message: string };
type Inventory = {
  name: string;
  source: 'accountMcp' | 'projectMcp';
  transport: 'http' | 'sse' | 'stdio' | 'unknown';
  status: 'enabled' | 'disabled' | 'unsupported' | 'invalid' | 'shadowed';
  reason?: string;
};
type HttpServer = { type: 'http' | 'sse'; url: string; headers?: Record<string, string> };
type Result = {
  settings: { permissions: { allow: string[]; deny: string[]; ask: string[] } };
  defaults: { model?: string; effort?: string };
  permissionMode: PermissionMode;
  allowedTools: string[];
  disallowedTools: string[];
  askTools: string[];
  mcpServers: Record<string, HttpServer>;
  strictMcpConfig: true;
  inventory: Inventory[];
  warnings: Warning[];
  configSources: { source: Source; status: 'missing' | 'loaded' | 'invalid' }[];
};

const aliases: Record<string, string[]> = {
  Read: ['read_file', 'read_image'], Glob: ['list_files', 'search_files'], Grep: ['search_files'],
  Write: ['write_file'], Edit: ['write_file'], MultiEdit: ['write_file'], Bash: ['run_command'],
};
const settingKeys = new Set(['permissions', 'model', 'effortLevel', 'enabledMcpJsonServers', 'disabledMcpJsonServers', 'enableAllProjectMcpServers', '$schema']);
const knownUnsupported = new Set(['hooks', 'env', 'apiKeyHelper', 'sandbox', 'plugins', 'enabledPlugins', 'extraKnownMarketplaces', 'outputStyle', 'statusLine', 'awsAuthRefresh', 'awsCredentialExport', 'otelHeadersHelper', 'forceLoginMethod', 'forceLoginOrgUUID', 'cleanupPeriodDays', 'additionalDirectories']);
const safeName = /^[A-Za-z0-9_-]{1,64}$/;
const reservedNames = new Set(['workspace', 'project_context', '__proto__', 'prototype', 'constructor']);
const maxDocumentBytes = 1024 * 1024;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function unique(values: string[]): string[] { return [...new Set(values)]; }
function validName(value: string): boolean { return safeName.test(value) && !reservedNames.has(value.toLowerCase()); }
/** Project-runtime composition and the workspace bridge match bounded MCP/name restrictions without regular-expression backtracking or shell-pattern reinterpretation. */
export function matchesProjectExtensionPermission(pattern: string, value: string): boolean {
  if (typeof pattern !== 'string' || typeof value !== 'string' || !pattern || !value || pattern.length > 512 || value.length > 512
    || !/^[A-Za-z0-9_*-]+$/.test(pattern) || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  let cursor = 0; let index = 0; let star = -1; let retry = 0;
  while (cursor < value.length) {
    if (index < pattern.length && pattern[index] === value[cursor]) { index++; cursor++; }
    else if (pattern[index] === '*') { star = index++; retry = cursor; }
    else if (star >= 0) { index = star + 1; cursor = ++retry; }
    else return false;
  }
  while (pattern[index] === '*') index++;
  return index === pattern.length;
}
function permissionMatches(pattern: string, value: string): boolean {
  return matchesProjectExtensionPermission(pattern, value);
}
function overlaps(left: string, right: string): boolean {
  if (permissionMatches(left, right) || permissionMatches(right, left)) return true;
  if (!left.includes('*') || !right.includes('*')) return false;
  const a = left.slice(0, left.indexOf('*')); const b = right.slice(0, right.indexOf('*'));
  return a.startsWith(b) || b.startsWith(a);
}

function localEndpoint(host: string): boolean {
  const hostname = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')
    || hostname.endsWith('.internal') || hostname.endsWith('.lan') || !hostname.includes('.')) return true;
  const kind = isIP(hostname);
  if (kind === 4) {
    const parts = hostname.split('.').map(Number);
    return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 || parts[0] >= 224
      || (parts[0] === 169 && parts[1] === 254) || (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31)
      || (parts[0] === 192 && (parts[1] === 168 || parts[1] === 0))
      || (parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127) || (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19));
  }
  // IPv6 endpoint support requires a connection-time address policy. In this
  // first batch fail closed, including mapped IPv4, link-local and zone ids.
  return kind === 6 || hostname.includes(':');
}

/** The project-runtime loader supplies already selected account/remote config; this pure policy builder never reads files, spawns hooks/stdio, or accesses credentials/network. */
export function resolveProjectExtensions(input: Input): Result {
  const warnings: Warning[] = [];
  let invalidPermissionConfig = false;
  const inventory: Inventory[] = [];
  const configSources: Result['configSources'] = [];
  const warningKeys = new Set<string>();
  const warn = (source: Warning['source'], code: string, message: string) => {
    const key = source + ':' + code + ':' + message;
    if (warnings.length < 128 && !warningKeys.has(key)) { warningKeys.add(key); warnings.push({ source, code, message }); }
  };
  const document = (source: Source): Record<string, unknown> => {
    const raw = input[source];
    if (raw === undefined || raw === null || raw === '') { configSources.push({ source, status: 'missing' }); return {}; }
    try {
      if (typeof raw === 'string' && Buffer.byteLength(raw, 'utf8') > maxDocumentBytes) throw new Error();
      const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!record(parsed) || Buffer.byteLength(JSON.stringify(parsed), 'utf8') > maxDocumentBytes) throw new Error();
      configSources.push({ source, status: 'loaded' }); return parsed;
    } catch {
      configSources.push({ source, status: 'invalid' });
      if (source.endsWith('Settings')) invalidPermissionConfig = true;
      warn(source, 'INVALID_CONFIG', 'Configuration must be a bounded JSON object; its contents were not loaded.'); return {};
    }
  };
  const list = (value: unknown, source: Source, field: string): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 512 || value.some(item => typeof item !== 'string' || item.length > 512 || /[\r\n\0]/.test(item))) {
      warn(source, 'INVALID_LIST', field + ' must be a bounded list of strings.'); return [];
    }
    return (value as string[]).map(item => item.trim()).filter(Boolean);
  };
  const rules = { allow: [] as string[], deny: [] as string[], ask: [] as string[] };
  const enabled = new Set<string>(); const disabled = new Set<string>();
  let enableAll = false; let configuredPlan = false; let configuredDontAsk = false;
  const defaults: Result['defaults'] = {};
  for (const source of ['accountSettings', 'projectSettings', 'localSettings'] as const) {
    const config = document(source);
    for (const key of Object.keys(config)) {
      if (!settingKeys.has(key)) warn(source, 'UNSUPPORTED_SETTING', knownUnsupported.has(key)
        ? 'Setting "' + key + '" is unsupported and will not execute in the VPS runtime.'
        : 'An unsupported setting was ignored.');
    }
    if (config.model !== undefined) {
      if (typeof config.model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(config.model)) defaults.model = config.model;
      else warn(source, 'INVALID_MODEL', 'The configured model identifier is invalid.');
    }
    if (config.effortLevel !== undefined) {
      if (typeof config.effortLevel === 'string' && ['low', 'medium', 'high', 'xhigh', 'max'].includes(config.effortLevel)) defaults.effort = config.effortLevel;
      else warn(source, 'INVALID_EFFORT', 'The configured effort level is unsupported.');
    }
    for (const name of list(config.enabledMcpJsonServers, source, 'enabledMcpJsonServers')) if (safeName.test(name)) enabled.add(name);
    for (const name of list(config.disabledMcpJsonServers, source, 'disabledMcpJsonServers')) if (safeName.test(name)) disabled.add(name);
    if (config.enableAllProjectMcpServers !== undefined) {
      if (typeof config.enableAllProjectMcpServers === 'boolean') enableAll = config.enableAllProjectMcpServers;
      else warn(source, 'INVALID_APPROVAL', 'enableAllProjectMcpServers must be a boolean.');
    }
    if (config.permissions === undefined) continue;
    if (!record(config.permissions)) { invalidPermissionConfig = true; warn(source, 'INVALID_PERMISSIONS', 'permissions must be an object.'); continue; }
    for (const key of Object.keys(config.permissions)) {
      if (!['allow', 'deny', 'ask', 'defaultMode'].includes(key)) warn(source, 'UNSUPPORTED_PERMISSION_SETTING', 'An unsupported permissions setting was ignored.');
    }
    const defaultMode = config.permissions.defaultMode;
    if (defaultMode === 'plan') configuredPlan = true;
    else if (defaultMode === 'dontAsk') configuredDontAsk = true;
    else if (defaultMode !== undefined && defaultMode !== 'default') warn(source, 'CONFIG_PERMISSION_ESCALATION_IGNORED', 'Configuration cannot enable an automatic edit or bypass permission mode; the session controls approval.');
    for (const kind of ['allow', 'deny', 'ask'] as const) {
      const rawRules = config.permissions[kind];
      if (kind !== 'allow' && rawRules !== undefined && (!Array.isArray(rawRules) || rawRules.length > 512 || rawRules.some(item => typeof item !== 'string' || item.length > 512 || /[\r\n\0]/.test(item)))) invalidPermissionConfig = true;
      for (const rule of list(config.permissions[kind], source, 'permissions.' + kind)) {
        if (Object.hasOwn(aliases, rule)) { rules[kind].push(...aliases[rule]!.map(name => 'mcp__workspace__' + name)); continue; }
        const patterned = /^([A-Za-z]+)\(.+\)$/.exec(rule);
        if (patterned && Object.hasOwn(aliases, patterned[1]!)) {
          warn(source, 'UNSUPPORTED_PERMISSION_PATTERN', 'Native command/path permission patterns cannot authorize Windows workspace tools.');
          if (kind !== 'allow') rules[kind].push(...aliases[patterned[1]!]!.map(name => 'mcp__workspace__' + name));
          continue;
        }
        if (/^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_*-]+$/.test(rule) || ['AskUserQuestion', 'ExitPlanMode', 'TodoWrite'].includes(rule)) rules[kind].push(rule);
        else {
          if (kind !== 'allow') invalidPermissionConfig = true;
          warn(source, 'UNSUPPORTED_PERMISSION_RULE', 'A permission rule is unsupported and was not granted.');
        }
      }
    }
  }
  const modes: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'];
  let permissionMode: PermissionMode = modes.includes(input.sessionPermissionMode as PermissionMode) ? input.sessionPermissionMode as PermissionMode : 'default';
  if (input.sessionPermissionMode !== undefined && !modes.includes(input.sessionPermissionMode as PermissionMode)) warn('session', 'INVALID_PERMISSION_MODE', 'An unsupported session permission mode was replaced with default approval.');
  if (input.readOnly || configuredPlan || permissionMode === 'plan') permissionMode = 'plan';
  else if (configuredDontAsk) permissionMode = 'dontAsk';
  const readOnly = permissionMode === 'plan';
  if (readOnly) rules.deny.push('mcp__workspace__write_file', 'mcp__workspace__run_command');
  if (invalidPermissionConfig) {
    rules.deny.push('mcp__*');
    warn('session', 'PERMISSIONS_FAIL_CLOSED', 'MCP tools are denied because a settings permission policy could not be safely loaded.');
  }

  const expand = (value: string): string | null => {
    if (value.length > 16_384 || /[\r\n\0]/.test(value)) return null;
    let replacements = 0; let invalid = false;
    const result = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]{0,127})(?::-([^{}]*))?\}/g, (_match, name: string, fallback: string | undefined) => {
      replacements++;
      const configured = input.env && Object.hasOwn(input.env, name) ? input.env[name] : undefined;
      const replacement = configured === undefined || configured === '' ? fallback : configured;
      if (replacements > 32 || typeof replacement !== 'string' || replacement.length > 16_384 || /[\r\n\0]/.test(replacement)) { invalid = true; return ''; }
      return replacement;
    });
    return invalid || result.length > 16_384 || result.includes('${') ? null : result;
  };
  const mcpServers: Record<string, HttpServer> = {};
  const declarations = new Map<string, { raw: unknown; source: 'accountMcp' | 'projectMcp'; item: Inventory }>();
  for (const source of ['accountMcp', 'projectMcp'] as const) {
    const config = document(source);
    if (config.mcpServers === undefined) continue;
    if (!record(config.mcpServers) || Object.keys(config.mcpServers).length > 64) { warn(source, 'INVALID_MCP_SERVERS', 'mcpServers must be an object containing at most 64 servers.'); continue; }
    for (const [rawName, raw] of Object.entries(config.mcpServers)) {
      const name = safeName.test(rawName) ? rawName : '[invalid-name]';
      const item: Inventory = { name, source, transport: record(raw) && (raw.type === 'http' || raw.type === 'sse') ? raw.type : record(raw) && (raw.type === 'stdio' || typeof raw.command === 'string') ? 'stdio' : 'unknown', status: 'invalid' };
      inventory.push(item);
      if (!validName(rawName)) { item.reason = reservedNames.has(rawName.toLowerCase()) ? 'RESERVED_SERVER_NAME' : 'INVALID_SERVER_NAME'; warn(source, item.reason, 'A reserved or invalid MCP server name was rejected.'); continue; }
      const previous = declarations.get(name);
      if (previous) { previous.item.status = 'shadowed'; previous.item.reason = 'PROJECT_OVERRIDE'; }
      declarations.set(name, { raw, source, item });
    }
  }
  for (const [name, { raw, source, item }] of declarations) {
    const reject = (status: Inventory['status'], reason: string, message: string) => { item.status = status; item.reason = reason; warn(source, reason, message); };
    if (!record(raw)) { reject('invalid', 'INVALID_MCP_SERVER', 'An MCP server declaration must be an object.'); continue; }
    if (item.transport === 'stdio' || raw.command !== undefined || raw.args !== undefined) { reject('unsupported', 'STDIO_UNSUPPORTED', 'Windows stdio MCP commands are not executed on the VPS.'); continue; }
    if (item.transport !== 'http' && item.transport !== 'sse') { reject('unsupported', 'TRANSPORT_UNSUPPORTED', 'Only explicit HTTP or SSE MCP transports are supported.'); continue; }
    if (typeof raw.url !== 'string') { reject('invalid', 'INVALID_MCP_URL', 'An MCP endpoint must be a valid public HTTP or HTTPS URL.'); continue; }
    const expandedUrl = expand(raw.url);
    if (expandedUrl === null) { reject('invalid', 'MCP_ENV_UNRESOLVED', 'An MCP environment reference is missing, invalid or exceeds its limit.'); continue; }
    let url: URL;
    try { url = new URL(expandedUrl); }
    catch { reject('invalid', 'INVALID_MCP_URL', 'An MCP endpoint must be a valid public HTTP or HTTPS URL.'); continue; }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash || expandedUrl.length > 4096) { reject('invalid', 'INVALID_MCP_URL', 'MCP endpoint protocols, user info or URL shape are unsupported.'); continue; }
    if (localEndpoint(url.hostname)) { reject('unsupported', 'LOCAL_ENDPOINT_UNSUPPORTED', 'Local, private and link-local MCP endpoints cannot be resolved as Windows services from the VPS.'); continue; }
    if (raw.env !== undefined || Object.keys(raw).some(key => !['type', 'url', 'headers'].includes(key))) warn(source, 'UNSUPPORTED_MCP_FIELD', 'Unsupported MCP fields were ignored; no server environment or executable is transferred.');
    let headers: Record<string, string> | undefined;
    if (raw.headers !== undefined) {
      if (!record(raw.headers) || Object.keys(raw.headers).length > 32) { reject('invalid', 'INVALID_MCP_HEADERS', 'MCP headers must be a bounded string map.'); continue; }
      headers = {}; let invalidHeaders = false;
      for (const [key, value] of Object.entries(raw.headers)) {
        if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(key) || ['host', 'connection', 'content-length', 'transfer-encoding', 'proxy-authorization', '__proto__', 'constructor', 'prototype'].includes(key.toLowerCase()) || typeof value !== 'string') { invalidHeaders = true; break; }
        const expanded = expand(value);
        if (expanded === null || expanded.length > 8192) { invalidHeaders = true; break; }
        headers[key] = expanded;
      }
      if (invalidHeaders) { reject('invalid', 'INVALID_MCP_HEADERS', 'MCP headers contain an invalid name, value or environment reference.'); continue; }
    }
    if (disabled.has(name)) { item.status = 'disabled'; item.reason = 'EXPLICITLY_DISABLED'; continue; }
    if (source === 'projectMcp' && !enableAll && !enabled.has(name)) { item.status = 'disabled'; item.reason = 'PROJECT_APPROVAL_REQUIRED'; continue; }
    if (readOnly) { reject('unsupported', 'READ_ONLY_MCP_UNSUPPORTED', 'External MCP tools are unavailable in a read-only session because their mutation behavior is unknown.'); continue; }
    mcpServers[name] = { type: item.transport, url: url.toString(), ...(headers && Object.keys(headers).length ? { headers } : {}) };
    item.status = 'enabled';
  }
  const disallowedTools = unique(rules.deny);
  // Preserve broad ask rules even when a narrower deny exists. Removing that
  // ask would let automatic inspection/edit grants approve its remaining tools.
  const askTools = unique(rules.ask);
  const allowedTools = unique(rules.allow).filter(rule => ![...disallowedTools, ...askTools].some(other => overlaps(other, rule)));
  if (permissionMode === 'bypassPermissions' && askTools.length) {
    permissionMode = 'default';
    warn('session', 'ASK_REQUIRES_PERMISSION_CHECK', 'Session bypass mode was replaced with normal approval to honor configured ask rules.');
  }
  return { settings: { permissions: { allow: allowedTools, deny: disallowedTools, ask: askTools } }, defaults,
    allowedTools, disallowedTools, askTools, permissionMode, mcpServers, strictMcpConfig: true, inventory, warnings, configSources };
}
