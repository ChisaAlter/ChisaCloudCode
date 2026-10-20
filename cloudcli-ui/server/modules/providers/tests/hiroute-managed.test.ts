import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import test, { mock } from 'node:test';

import type { ClaudeModelConnectionSecret } from '@/shared/types.js';

type Json = Record<string, any>;
const absent = () => Object.assign(new Error('Fixture credential file absent'), { code: 'ENOENT' });
let credentialRead: () => Promise<string> = async () => { throw absent(); };
let connections: ClaudeModelConnectionSecret[] = [];
let commands: { command: string; input?: Json }[] = [];
let bridged: string | null | undefined;
let hostCreations = 0;
let hostDisposals = 0;
let commandScenario: (command: string, input?: Json) => Promise<Json>;
let bridgeScenario: () => Promise<void> = async () => {};
mock.module('node:fs/promises', { namedExports: { ...fs, readFile: async () => credentialRead() } });
mock.module('@/modules/database/index.js', { namedExports: { claudeConnectionsDb: { list: () => connections } } });
mock.module('@/modules/providers/services/hiroute-host.service.js', { namedExports: {
  createHiRouteHost: async (userId: number, generation: string) => {
    hostCreations++;
    assert.equal(userId, 42);
    assert.match(generation, /^[a-f0-9]{64}$/);
    return {
      ensure: async () => {},
      dispose: async () => { hostDisposals++; },
      bridgeCredentials: async (value: string | null) => { bridged = value; await bridgeScenario(); },
      cli: async (args: string[], input?: Json) => { const command = args.join(' '); commands.push({ command, input }); return commandScenario(command, input); },
      secret: async (candidate: string, key: string) => { assert.equal(key, 'fixture-private-key'); return { candidate: { candidate_ref: candidate, candidate_revision: 1 } }; },
      grant: async () => 'fixture-gateway-grant',
    };
  },
} });
const { prepareManagedHiRoute, releaseManagedHiRoute } = await import('@/modules/providers/services/hiroute-managed.service.js');

const saved = (id: string, model = 'model-a'): ClaudeModelConnectionSecret => ({ id, name: 'Shared label', baseUrl: 'https://fixture.example/anthropic', model, authType: 'api_key', apiKey: 'fixture-private-key' });
const plan = { desired: { display_name: 'Chisa HiRoute' }, agent_plan_id: 'plan-fixture', head: { model_alias: 'plan/fixture' } };
function connected(command: string): Json {
  if (command === 'routing list') return { plans: [plan] };
  if (command === 'agents scan') return { agents: [{ agent_id: 'agent_claude_default', context_id: 'context-fixture' }] };
  if (command === 'agents connect preview') return { applicable: true, blockers: [], spec: {}, accept_digest: 'fixture', expected_revisions: {}, dependency_digest: 'fixture' };
  if (command === 'agents connect apply') return { operation: { state: 'succeeded' } };
  if (command === 'gateway show') return { ready: true, connect_address: '127.0.0.1:46559' };
  throw new Error(`Unexpected fixture command ${command}`);
}
async function fixture(run: () => Promise<void>) {
  const keys = ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR'];
  const environment = keys.map(key => [key, process.env[key]] as const);
  for (const key of keys) delete process.env[key];
  connections = []; commands = []; bridged = undefined; hostCreations = 0; hostDisposals = 0;
  credentialRead = async () => { throw absent(); };
  bridgeScenario = async () => {};
  commandScenario = async command => connected(command);
  try { await run(); }
  finally {
    await releaseManagedHiRoute(42);
    await releaseManagedHiRoute(42);
    for (const [key, value] of environment) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

test('managed HiRoute fails before host creation when no saved or native source exists', async () => {
  await fixture(async () => {
    await assert.rejects(prepareManagedHiRoute(42), { code: 'HIROUTE_PREPARATION_FAILED' });
    assert.equal(hostCreations, 0);
  });
});

test('environment-only OAuth works without a credentials file and bridges no refresh secret', async () => {
  await fixture(async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fixture-oauth-access';
    const result = await prepareManagedHiRoute(42);
    const bridge = JSON.parse(bridged!);
    assert.equal(bridge.claudeAiOauth.accessToken, 'fixture-oauth-access');
    assert.equal(bridge.claudeAiOauth.refreshToken, undefined);
    assert.ok(bridge.claudeAiOauth.expiresAt > Date.now());
    assert.deepEqual(result, { enabled: true, baseUrl: 'http://127.0.0.1:46559', routeModel: 'plan/fixture', authToken: 'fixture-gateway-grant' });
  });
});

test('native bridge carries current access credentials without the refresh token', async () => {
  await fixture(async () => {
    credentialRead = async () => JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh-must-stay-native', expiresAt: Date.now() + 60000, scopes: ['user:inference'], subscriptionType: 'max' } });
    await prepareManagedHiRoute(42);
    assert.equal(JSON.parse(bridged!).claudeAiOauth.accessToken, 'fixture-access');
    assert.equal(bridged!.includes('fixture-refresh-must-stay-native'), false);
  });
});

test('expired native credentials cannot create an apparently usable managed gateway', async () => {
  await fixture(async () => {
    credentialRead = async () => JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-expired', expiresAt: 1 } });
    await assert.rejects(prepareManagedHiRoute(42), { code: 'HIROUTE_PREPARATION_FAILED' });
    assert.equal(hostCreations, 0);
  });
});

test('managed preparation honors cancellation before and during host initialization', async () => {
  await fixture(async () => {
    connections = [saved('first')];
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(prepareManagedHiRoute(42, controller.signal), { name: 'AbortError' });
    assert.equal(hostCreations, 0);
    const during = new AbortController();
    bridgeScenario = async () => { during.abort(); };
    await assert.rejects(prepareManagedHiRoute(42, during.signal), { name: 'AbortError' });
    assert.equal(commands.length, 0);
  });
});

test('a bridged subscription must discover a matching connector candidate', async () => {
  await fixture(async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fixture-access';
    commandScenario = async command => {
      if (command === 'routing list') return { plans: [] };
      if (command === 'compute list') return { sources: [], revisions: {} };
      if (command === 'compute connection options') return { subscriptions: { candidates: [] } };
      throw new Error(`Subscription discovery must fail before ${command}`);
    };
    await assert.rejects(prepareManagedHiRoute(42), { code: 'HIROUTE_PREPARATION_FAILED' });
    assert.equal(commands.some(call => call.command === 'routing apply'), false);
  });
});

test('retry distinguishes saved models sharing a label and preserves subscription routing priority', async () => {
  await fixture(async () => {
    connections = [saved('first'), saved('second', 'model-b')];
    const nativeSource = { source_id: 'native-source', display_name: 'Chisa connection first', provenance: 'user_configured', connection_identity: { access_kind: 'api' }, target: { scheme: 'https', authority: 'fixture.example', port: 443, request_path: '/anthropic/v1/messages', upstream_protocol: 'messages', protocol_profile_id: 'profile/custom/messages', protocol_profile_revision: 1 }, authentication: { kind: 'api_key_header', header: 'x-api-key' }, models: [{ binding_id: 'native-a', upstream_model_id: 'model-a' }] };
    const subscriptionSource = { source_id: 'subscription-source', display_name: 'Claude', provenance: 'connector_owned', connection_identity: { access_kind: 'subscription' }, models: [{ binding_id: 'subscription-opus', upstream_model_id: 'claude-opus' }] };
    const candidates = [
      { binding_id: 'native-a', display_name: 'Native A', routable: true, ingress_protocols: ['messages'] },
      { binding_id: 'subscription-opus', display_name: 'Opus', routable: true, ingress_protocols: ['messages'] },
      { binding_id: 'native-b', display_name: 'Native B', routable: true, ingress_protocols: ['messages'] },
    ];
    let published = false;
    commandScenario = async (command, input) => {
      if (command === 'routing list') return { plans: published ? [plan] : [] };
      if (command === 'compute list') return { sources: [nativeSource, subscriptionSource], revisions: {} };
      if (command === 'routing options') return { candidates };
      if (command === 'compute connection test') {
        assert.equal(input?.request.draft.models[0].upstream_model_id, 'model-b');
        assert.equal(input?.request.draft.authentication.kind, 'api_key_header');
        return { candidate: { candidate: { candidate_ref: 'second', candidate_revision: 1 }, models: [{ model_ref: 'second-model', selectable: true }] } };
      }
      if (command === 'compute connection preview') return { spec: {}, accept_digest: 'fixture', expected_revisions: {} };
      if (command === 'compute connection apply') return { operation: { state: 'succeeded' } };
      if (command === 'routing preview') {
        assert.deepEqual(input?.change.editor.smart.primary.map((entry: Json) => entry.binding_id), ['subscription-opus', 'native-a', 'native-b']);
        assert.deepEqual(input?.change.editor.smart.economy.map((entry: Json) => entry.binding_id), ['native-a', 'native-b', 'subscription-opus']);
        return { change_digest: 'fixture', expected_revisions: {} };
      }
      if (command === 'routing apply') { published = true; return { operation: { state: 'succeeded' } }; }
      return connected(command);
    };
    await prepareManagedHiRoute(42);
    assert.equal(commands.filter(call => call.command === 'compute connection test').length, 1);
  });
});

test('unknown ingress authentication runs one native check and applies only the refreshed preview', async () => {
  await fixture(async () => {
    connections = [saved('first')];
    let previews = 0;
    commandScenario = async (command, input) => {
      if (command === 'agents connect preview') {
        previews++;
        if (previews === 1) return { applicable: false, blockers: [{ capabilities: [{ capability: 'ingress_authentication', reason: 'unknown' }] }] };
        return { applicable: true, blockers: [], spec: { refreshed: true }, accept_digest: 'refreshed', expected_revisions: {}, dependency_digest: 'refreshed-dependencies' };
      }
      if (command === 'agents check agent_claude_default --scope native-authentication --suite quick') return {};
      if (command === 'agents connect apply') {
        assert.equal(input?.spec.refreshed, true);
        assert.equal(input?.accept_digest, 'refreshed');
        assert.equal(input?.dependency_digest, 'refreshed-dependencies');
      }
      return connected(command);
    };
    await prepareManagedHiRoute(42);
    assert.equal(previews, 2);
    assert.equal(commands.filter(call => call.command.startsWith('agents check ')).length, 1);
    assert.deepEqual(commands.map(call => call.command).filter(command => command.startsWith('agents connect') || command.startsWith('agents check')), [
      'agents connect preview', 'agents check agent_claude_default --scope native-authentication --suite quick', 'agents connect preview', 'agents connect apply',
    ]);
  });
});

test('proven ingress authentication connects without a native check', async () => {
  await fixture(async () => {
    connections = [saved('first')];
    await prepareManagedHiRoute(42);
    assert.equal(commands.filter(call => call.command === 'agents connect preview').length, 1);
    assert.equal(commands.some(call => call.command.startsWith('agents check ')), false);
  });
});

test('unrelated connect blockers fail without running a native authentication check', async () => {
  await fixture(async () => {
    connections = [saved('first')];
    commandScenario = async command => command === 'agents connect preview'
      ? { applicable: false, blockers: [{ capabilities: [{ capability: 'streaming', reason: 'unknown' }, { capability: 'ingress_authentication', reason: 'unsupported' }] }] }
      : connected(command);
    await assert.rejects(prepareManagedHiRoute(42), { code: 'HIROUTE_PREPARATION_FAILED' });
    assert.equal(commands.some(call => call.command.startsWith('agents check ')), false);
    assert.equal(commands.some(call => call.command === 'agents connect apply'), false);
  });
});

test('overlapping managed sessions retain their host until the last lease releases', async () => {
  await fixture(async () => {
    connections = [saved('first')];
    await Promise.all([prepareManagedHiRoute(42), prepareManagedHiRoute(42)]);
    assert.equal(hostDisposals, 0);
    await releaseManagedHiRoute(42);
    assert.equal(hostDisposals, 0);
    await releaseManagedHiRoute(42);
    assert.equal(hostDisposals, 1);
    await releaseManagedHiRoute(42);
    assert.equal(hostDisposals, 1);
  });
});

test('failed managed setup disposes its host without requiring a successful request lease', async () => {
  await fixture(async () => {
    connections = [saved('first')];
    commandScenario = async () => { throw new Error('Fixture host failed'); };
    await assert.rejects(prepareManagedHiRoute(42), /Fixture host failed/);
    assert.equal(hostDisposals, 1);
    await releaseManagedHiRoute(42);
    assert.equal(hostDisposals, 1);
  });
});

test('subscription approval saves only verified selectable models and includes its validation reference', async () => {
  await fixture(async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fixture-access';
    const candidate = { candidate_ref: 'candidate/claude/fixture', candidate_revision: 1 };
    const checked = { candidate: { ...candidate, candidate_revision: 2 }, models: [{ model_ref: 'opus', selectable: true }, { model_ref: 'blocked', selectable: false }] };
    const operation = { operation_id: 'approval-fixture', state: 'succeeded' };
    const validation = { approval_operation: operation, validation_ref: 'verified-fixture', validation_revision: 1 };
    let savedSource = false;
    let published = false;
    commandScenario = async (command, input) => {
      if (command === 'routing list') return { plans: published ? [plan] : [] };
      if (command === 'compute list') return { sources: savedSource ? [{ provenance: 'connector_owned', models: [{ binding_id: 'opus-binding' }] }] : [], revisions: {} };
      if (command === 'compute connection options') return { subscriptions: { candidates: [{ candidate, display_name: 'Claude fixture', provenance: 'connector_owned' }, { candidate: { candidate_ref: 'candidate/unrelated', candidate_revision: 1 }, display_name: 'Other subscription', provenance: 'connector_owned' }] } };
      if (command === 'compute connection preview') {
        if (input?.candidate) assert.deepEqual(input.candidate, candidate);
        else {
          assert.deepEqual(input?.change.subject, { kind: 'candidate', candidate: checked.candidate });
          assert.deepEqual(input?.change.validation, validation);
          assert.deepEqual(input?.change.selected_model_refs, ['opus']);
          assert.equal(input?.change.intent, 'save_ready');
        }
        return { spec: { saving: !!input?.change }, accept_digest: 'fixture', expected_revisions: {} };
      }
      if (command === 'compute connection apply') { if (input?.spec.saving) savedSource = true; return { operation }; }
      if (command === 'compute connection authorize') { assert.deepEqual(input?.operation, operation); return { status: 'verified', candidate, checked_candidate: checked, validation }; }
      if (command === 'routing options') return { candidates: [{ binding_id: 'opus-binding', display_name: 'Opus', routable: true, ingress_protocols: ['messages'] }] };
      if (command === 'routing preview') return { change_digest: 'fixture', expected_revisions: {} };
      if (command === 'routing apply') { published = true; return { operation: { state: 'succeeded' } }; }
      return connected(command);
    };
    await prepareManagedHiRoute(42);
    assert.equal(savedSource, true);
    assert.equal(commands.filter(call => call.command === 'compute connection authorize').length, 1);
  });
});
