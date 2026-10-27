import assert from 'node:assert/strict';
import test from 'node:test';

import { matchesProjectExtensionPermission, resolveProjectExtensions } from '../project-runtime-extensions.service.js';

const command = 'mcp__workspace__run_command';
const write = 'mcp__workspace__write_file';
const read = 'mcp__workspace__read_file';
const server = (url = 'https://mcp.example.com/tools') => ({ type: 'http', url });

test('empty sources keep strict configuration and do not grant project or extension tools', () => {
  const result = resolveProjectExtensions({});
  assert.equal(result.strictMcpConfig, true);
  assert.deepEqual(result.settings, { permissions: { allow: [], deny: [], ask: [] } });
  assert.deepEqual(result.defaults, {});
  assert.deepEqual(result.mcpServers, {});
  assert.deepEqual(result.allowedTools, []);
  assert.equal(result.permissionMode, 'default');
  assert.equal(result.configSources.length, 5);
  assert.ok(result.configSources.every(source => source.status === 'missing'));
  assert.deepEqual(result.warnings, []);
});

test('account/project/local safe defaults follow precedence without forwarding executable settings or environment', () => {
  const input = {
    accountSettings: { model: 'account-model', effortLevel: 'low', permissions: { allow: ['Read'] }, env: { API_KEY: 'do-not-transfer' } },
    projectSettings: JSON.stringify({ model: 'project-model', effortLevel: 'medium', hooks: { PreToolUse: [{ command: 'dangerous-command' }] }, plugins: ['C:\\private\\plugin'], apiKeyHelper: 'dangerous-helper', sandbox: { enabled: true }, outputStyle: 'private-style' }),
    localSettings: { model: 'local-model', effortLevel: 'high' },
  };
  const before = JSON.stringify(input);
  const result = resolveProjectExtensions(input);
  assert.deepEqual(result.defaults, { model: 'local-model', effort: 'high' });
  assert.equal(result.settings.permissions.allow.includes(read), true);
  assert.deepEqual(Object.keys(result.settings), ['permissions']);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(result.warnings.filter(warning => warning.code === 'UNSUPPORTED_SETTING').map(warning => warning.message).sort(), [
    'Setting "env" is unsupported and will not execute in the VPS runtime.',
    'Setting "hooks" is unsupported and will not execute in the VPS runtime.',
    'Setting "plugins" is unsupported and will not execute in the VPS runtime.',
    'Setting "apiKeyHelper" is unsupported and will not execute in the VPS runtime.',
    'Setting "sandbox" is unsupported and will not execute in the VPS runtime.',
    'Setting "outputStyle" is unsupported and will not execute in the VPS runtime.',
  ].sort());
  assert.doesNotMatch(JSON.stringify(result), /do-not-transfer|dangerous-command|dangerous-helper|private-style|private\\\\plugin/);
});

test('native whole-tool aliases map to Windows project tools; shell/path patterns never grant execution', () => {
  const result = resolveProjectExtensions({ accountSettings: { permissions: { allow: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'MultiEdit', 'Bash', 'Bash(npm run test:*)', 'Read(./secret/**)', 'mcp__docs_server__lookup_*', 'WebFetch', 'constructor'] } } });
  assert.deepEqual(result.allowedTools, [read, 'mcp__workspace__read_image', 'mcp__workspace__list_files', 'mcp__workspace__search_files', write, command, 'mcp__docs_server__lookup_*']);
  assert.ok(result.warnings.some(warning => warning.code === 'UNSUPPORTED_PERMISSION_PATTERN'));
  assert.ok(result.warnings.some(warning => warning.code === 'UNSUPPORTED_PERMISSION_RULE'));
  const patterned = resolveProjectExtensions({ projectSettings: { permissions: { allow: ['Bash(npm:*)', 'Edit(./src/**)'] } } });
  assert.deepEqual(patterned.allowedTools, []);
});

test('deny and ask rules override overlapping grants across every settings scope', () => {
  const result = resolveProjectExtensions({
    accountSettings: { permissions: { allow: ['mcp__workspace__*', 'mcp__docs__*', 'Bash', 'Write', 'Read'] } },
    projectSettings: { permissions: { deny: ['Bash(git push:*)', 'mcp__docs__delete_*'] } },
    localSettings: { permissions: { ask: ['Read(./private/**)', 'Write'] } },
  });
  assert.ok(result.disallowedTools.includes(command));
  assert.ok(result.disallowedTools.includes('mcp__docs__delete_*'));
  assert.ok(result.askTools.includes(read));
  assert.ok(result.askTools.includes(write));
  assert.deepEqual(result.allowedTools, []);
  const broadAsk = resolveProjectExtensions({ accountSettings: { permissions: { ask: ['mcp__workspace__*'], deny: ['Bash'] } } });
  assert.ok(broadAsk.askTools.includes('mcp__workspace__*'));
  assert.ok(broadAsk.disallowedTools.includes(command));
});

test('config permissions never elevate approval mode and acceptEdits does not grant commands', () => {
  for (const mode of ['acceptEdits', 'bypassPermissions', 'auto']) {
    const result = resolveProjectExtensions({ accountSettings: { permissions: { defaultMode: mode } } });
    assert.equal(result.permissionMode, 'default');
    assert.ok(result.warnings.some(warning => warning.code === 'CONFIG_PERMISSION_ESCALATION_IGNORED'));
  }
  const accept = resolveProjectExtensions({ sessionPermissionMode: 'acceptEdits' });
  assert.equal(accept.permissionMode, 'acceptEdits');
  assert.equal(accept.allowedTools.includes(command), false);
  assert.equal(accept.allowedTools.includes(write), false, 'the caller owns automatic edit policy');
  assert.equal(resolveProjectExtensions({ sessionPermissionMode: 'bypassPermissions' }).permissionMode, 'bypassPermissions');
  assert.equal(resolveProjectExtensions({ accountSettings: { permissions: { defaultMode: 'dontAsk' } }, sessionPermissionMode: 'bypassPermissions' }).permissionMode, 'dontAsk');
});

test('ask rules downgrade bypass mode so SDK callbacks cannot be skipped', () => {
  const result = resolveProjectExtensions({ sessionPermissionMode: 'bypassPermissions', localSettings: { permissions: { ask: ['Bash', 'mcp__docs__*'], allow: ['Bash'] } } });
  assert.equal(result.permissionMode, 'default');
  assert.deepEqual(result.allowedTools, []);
  assert.ok(result.warnings.some(warning => warning.code === 'ASK_REQUIRES_PERMISSION_CHECK'));
  assert.equal(resolveProjectExtensions({ sessionPermissionMode: 'bypassPermissions', localSettings: { permissions: { deny: ['Bash'] } } }).permissionMode, 'bypassPermissions');
  assert.equal(resolveProjectExtensions({ sessionPermissionMode: 'auto', localSettings: { permissions: { ask: ['Bash'] } } }).permissionMode, 'default');
});

test('bounded permission matching handles MCP wildcards and never shell patterns or unbounded regular expressions', () => {
  for (const [rule, name] of [['mcp__*', read], ['mcp__workspace__*', command], ['mcp__docs__read_*', 'mcp__docs__read_page'], ['mcp__*_server__read*', 'mcp__docs_server__read_page'], ['Read', 'Read']]) assert.equal(matchesProjectExtensionPermission(rule!, name!), true, rule);
  for (const [rule, name] of [['mcp__docs__read_*', command], ['Bash(npm:*)', command], ['mcp__docs__[a-z]+', 'mcp__docs__read'], ['mcp__docs__*', 'mcp__docs__read\nsecret'], ['a'.repeat(513), 'a']]) assert.equal(matchesProjectExtensionPermission(rule!, name!), false, rule);
  assert.equal(matchesProjectExtensionPermission('*a'.repeat(200) + 'b', 'a'.repeat(400)), false);
});

test('project HTTP/SSE require configured project approval; account configured server is selected without autoapproving tools', () => {
  const input = { accountMcp: { mcpServers: { account_docs: server() } }, projectMcp: { mcpServers: { project_docs: server(), project_sse: { type: 'sse', url: 'https://events.example.com/sse' } } } };
  const unapproved = resolveProjectExtensions(input);
  assert.deepEqual(Object.keys(unapproved.mcpServers), ['account_docs']);
  assert.equal(unapproved.inventory.find(item => item.name === 'project_docs')?.reason, 'PROJECT_APPROVAL_REQUIRED');
  const selected = resolveProjectExtensions({ ...input, localSettings: { enabledMcpJsonServers: ['project_docs', 'project_sse'] } });
  assert.deepEqual(Object.keys(selected.mcpServers), ['account_docs', 'project_docs', 'project_sse']);
  assert.equal(selected.mcpServers.project_sse?.type, 'sse');
  assert.deepEqual(selected.allowedTools, [], 'connecting a configured MCP server does not bypass tool approval');
  const all = resolveProjectExtensions({ ...input, projectSettings: { enableAllProjectMcpServers: true }, localSettings: { disabledMcpJsonServers: ['project_docs', 'account_docs'] } });
  assert.deepEqual(Object.keys(all.mcpServers), ['project_sse']);
  assert.ok(all.inventory.filter(item => ['project_docs', 'account_docs'].includes(item.name)).every(item => item.reason === 'EXPLICITLY_DISABLED'));
});

test('project declarations shadow account declarations without falling back to a different endpoint', () => {
  const result = resolveProjectExtensions({ accountMcp: { mcpServers: { docs: server('https://account.example.com/mcp') } }, projectMcp: { mcpServers: { docs: { command: 'windows-private-command', args: ['secret-argument'] } } }, projectSettings: { enableAllProjectMcpServers: true } });
  assert.deepEqual(result.mcpServers, {});
  assert.deepEqual(result.inventory.map(item => [item.status, item.reason]), [['shadowed', 'PROJECT_OVERRIDE'], ['unsupported', 'STDIO_UNSUPPORTED']]);
  assert.doesNotMatch(JSON.stringify(result), /windows-private-command|secret-argument|account\.example/);
});

test('reserved and invalid server names cannot replace workspace or project-context capabilities', () => {
  const servers = JSON.parse('{"workspace":{"type":"http","url":"https://example.com"},"project_context":{"type":"http","url":"https://example.com"},"Workspace":{"type":"http","url":"https://example.com"},"__proto__":{"type":"http","url":"https://example.com"},"constructor":{"type":"http","url":"https://example.com"},"private/key?secret":{"type":"http","url":"https://example.com"},"docs_valid-name":{"type":"http","url":"https://example.com"}}');
  const result = resolveProjectExtensions({ accountMcp: { mcpServers: servers } });
  assert.deepEqual(Object.keys(result.mcpServers), ['docs_valid-name']);
  assert.equal(result.inventory.filter(item => item.reason === 'RESERVED_SERVER_NAME').length, 5);
  assert.doesNotMatch(JSON.stringify(result.inventory), /private\/key\?secret/);
  assert.equal(Object.getPrototypeOf(result.mcpServers), Object.prototype);
});

test('stdio/commands and implicit transports are reported unsupported and never sent to SDK MCP configuration', () => {
  const result = resolveProjectExtensions({ accountMcp: { mcpServers: {
    win: { command: 'C:\\Windows\\System32\\cmd.exe', args: ['/c', 'private-command'], env: { TOKEN: 'private-stdio-token' } },
    mixed: { type: 'http', url: 'https://docs.example.com', command: 'node' },
    implicit: { url: 'https://docs.example.com' },
    sdk: { type: 'sdk', name: 'workspace' },
  } } });
  assert.deepEqual(result.mcpServers, {});
  assert.ok(result.inventory.every(item => item.status === 'unsupported'));
  assert.doesNotMatch(JSON.stringify(result), /cmd\.exe|private-command|private-stdio-token/);
});

test('loopback/private/link-local/encoded addresses and credentials never become VPS MCP endpoints', () => {
  const endpoints = [
    'http://localhost:3000/mcp', 'http://LOCALHOST./mcp', 'http://test.localhost/mcp', 'http://desktop/mcp', 'http://desktop.local/mcp',
    'http://127.0.0.1/mcp', 'http://127.1/mcp', 'http://2130706433/mcp', 'http://0x7f000001/mcp', 'http://0177.0.0.1/mcp',
    'http://10.1.2.3/mcp', 'http://172.16.0.2/mcp', 'http://192.168.1.3/mcp', 'http://169.254.169.254/latest', 'http://100.64.1.1/mcp',
    'http://[::1]/mcp', 'http://[::ffff:127.0.0.1]/mcp', 'http://[fe80::1]/mcp', 'http://[fc00::1]/mcp',
    'http://secretuser:secretpass@public.example.com/mcp', 'file:///private/secretfile', 'https://public.example.com/mcp#private-fragment',
  ];
  for (const url of endpoints) {
    const result = resolveProjectExtensions({ accountMcp: { mcpServers: { docs: server(url) } } });
    assert.deepEqual(result.mcpServers, {}, url);
    assert.ok(result.inventory[0]?.reason, url);
    assert.doesNotMatch(JSON.stringify(result), /secretuser|secretpass|secretfile|private-fragment/);
  }
});

test('selected environment expansion is bounded and credentials exist only in private SDK MCP options', () => {
  const result = resolveProjectExtensions({
    accountMcp: { mcpServers: { docs: { type: 'http', url: 'https://${HOST:-docs.example.com}/mcp?key=${API_KEY}', headers: { Authorization: 'Bearer ${API_KEY}', 'X-Region': '${REGION:-west}' } } } },
    env: { API_KEY: 'account-secret-token' },
  });
  assert.equal(result.mcpServers.docs?.headers?.Authorization, 'Bearer account-secret-token');
  assert.equal(result.mcpServers.docs?.headers?.['X-Region'], 'west');
  assert.equal(result.mcpServers.docs?.url, 'https://docs.example.com/mcp?key=account-secret-token');
  assert.doesNotMatch(JSON.stringify({ inventory: result.inventory, warnings: result.warnings, configSources: result.configSources, settings: result.settings, defaults: result.defaults }), /account-secret-token|Authorization|API_KEY|HOST|docs\.example/);
  const unresolved = resolveProjectExtensions({ accountMcp: { mcpServers: { docs: server('https://docs.example.com/${MISSING_SECRET}') } } });
  assert.equal(unresolved.inventory[0]?.reason, 'MCP_ENV_UNRESOLVED');
  assert.doesNotMatch(JSON.stringify(unresolved), /MISSING_SECRET/);
  const redirected = resolveProjectExtensions({ accountMcp: { mcpServers: { docs: server('${ENDPOINT}') } }, env: { ENDPOINT: 'http://127.0.0.1/mcp' } });
  assert.equal(redirected.inventory[0]?.reason, 'LOCAL_ENDPOINT_UNSUPPORTED');
  const oversized = resolveProjectExtensions({ accountMcp: { mcpServers: { docs: { type: 'http', url: 'https://docs.example.com', headers: { Authorization: '${TOKEN}' } } } }, env: { TOKEN: 'x'.repeat(20_000) } });
  assert.deepEqual(oversized.mcpServers, {});
});

test('invalid header names, line breaks, unsafe routing overrides and malformed declarations fail closed', () => {
  for (const headers of [{ Authorization: 'secret\r\nHost: localhost' }, { Host: 'localhost' }, { 'Proxy-Authorization': 'secret' }, { 'Bad Name': 'secret' }, { Authorization: 1 }, []]) {
    const result = resolveProjectExtensions({ accountMcp: { mcpServers: { docs: { ...server(), headers } } } });
    assert.deepEqual(result.mcpServers, {});
    assert.equal(result.inventory[0]?.reason, 'INVALID_MCP_HEADERS');
    assert.doesNotMatch(JSON.stringify(result), /secret/);
  }
  const result = resolveProjectExtensions({ accountMcp: { mcpServers: { docs: null, malformed: [], invalidUrl: { type: 'http', url: 'private malformed token' } } } });
  assert.deepEqual(result.mcpServers, {});
  assert.doesNotMatch(JSON.stringify(result), /private malformed token/);
});

test('plan/read-only overrides bypass and disables mutation-capable external MCP without losing diagnostics', () => {
  for (const input of [{ readOnly: true, sessionPermissionMode: 'bypassPermissions' }, { sessionPermissionMode: 'plan' }, { projectSettings: { permissions: { defaultMode: 'plan' } }, sessionPermissionMode: 'acceptEdits' }]) {
    const result = resolveProjectExtensions({ ...input, accountSettings: { permissions: { allow: ['Bash', 'Write', 'mcp__workspace__*'] } }, accountMcp: { mcpServers: { docs: server() } } });
    assert.equal(result.permissionMode, 'plan');
    assert.deepEqual(result.mcpServers, {});
    assert.ok(result.disallowedTools.includes(command));
    assert.ok(result.disallowedTools.includes(write));
    assert.deepEqual(result.allowedTools, []);
    assert.equal(result.inventory[0]?.reason, 'READ_ONLY_MCP_UNSUPPORTED');
  }
});

test('malformed deny/ask policies and unreadable settings cannot fall back to lower-scope automatic grants', () => {
  for (const projectSettings of [{ permissions: { deny: ['Bash', 7] } }, { permissions: { ask: 'Read' } }, { permissions: null }, { permissions: { deny: ['UnknownTool(secret)'] } }, '{"permissions":']) {
    const result = resolveProjectExtensions({ accountSettings: { permissions: { allow: ['Bash', 'Read', 'mcp__docs__*'] } }, projectSettings });
    assert.ok(result.disallowedTools.includes('mcp__*'));
    assert.deepEqual(result.allowedTools, []);
    assert.ok(result.warnings.some(warning => warning.code === 'PERMISSIONS_FAIL_CLOSED'));
    assert.doesNotMatch(JSON.stringify(result.warnings), /secret/);
  }
});

test('malformed/oversized config schemas produce bounded redacted warnings rather than raw parser errors', () => {
  const circular: Record<string, unknown> = {}; circular.self = circular;
  for (const value of ['{"secret-token":', 'x'.repeat(1024 * 1024 + 1), [], 42, circular]) {
    const result = resolveProjectExtensions({ projectSettings: value });
    assert.equal(result.configSources.find(source => source.source === 'projectSettings')?.status, 'invalid');
    assert.doesNotMatch(JSON.stringify(result), /secret-token|Unexpected|JSON\.parse|SyntaxError/);
  }
  const result = resolveProjectExtensions({ accountSettings: { permissions: { allow: ['Bash', 5], deny: 'Read' }, enabledMcpJsonServers: [9], enableAllProjectMcpServers: 'true', model: '\nprivate', effortLevel: 'private' }, accountMcp: { mcpServers: Object.fromEntries(Array.from({ length: 65 }, (_, index) => ['server' + index, server()])) } });
  assert.deepEqual(result.allowedTools, []);
  assert.deepEqual(result.mcpServers, {});
  assert.ok(result.warnings.length < 128);
  assert.ok(result.warnings.some(warning => warning.code === 'INVALID_MCP_SERVERS'));
  assert.deepEqual(result.defaults, {});
});
