import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { claudeConnectionsDb } from '@/modules/database/index.js';
import { claudeAccountsService } from '@/modules/providers/services/claude-accounts.service.js';
import { createHiRouteHost } from '@/modules/providers/services/hiroute-host.service.js';
import type { ClaudeAccountLaunchSnapshot, ClaudeModelConnectionSecret, HiRouteConnection } from '@/shared/types.js';
import { AppError, requireConnectionUserId } from '@/shared/utils.js';

type Host = Awaited<ReturnType<typeof createHiRouteHost>>;
type Json = Record<string, any>;
type Subscription = { accessToken: string; expiresAt: number; scopes?: string[]; subscriptionType?: string };
const pending = new Map<number, Promise<unknown>>();
const leases = new Map<number, { count: number; hosts: Map<string, Host>; accountReleases: Array<() => void> }>();

async function serialized<T>(userId: number, work: () => Promise<T>): Promise<T> {
  const previous = pending.get(userId) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(work);
  pending.set(userId, operation);
  try { return await operation; }
  finally { if (pending.get(userId) === operation) pending.delete(userId); }
}

function failure(message: string): AppError {
  return new AppError(message, { code: 'HIROUTE_PREPARATION_FAILED', statusCode: 503 });
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function readSubscription(userId: number, snapshot: ClaudeAccountLaunchSnapshot | null): Promise<Subscription | null> {
  // Use the same per-user selection as ordinary Claude launches and the usage panel.
  const subscription = snapshot ? await claudeAccountsService.readSubscription(userId, snapshot) : null;
  if (!subscription || /[\x00-\x20\x7f]/.test(subscription.accessToken)
    || (subscription.expiresAt !== null && subscription.expiresAt <= Date.now())) return null;
  // Claude alone refreshes credentials; the gateway receives only the current access token.
  return { accessToken: subscription.accessToken, expiresAt: subscription.expiresAt ?? Date.now() + 60 * 60 * 1000,
    ...(subscription.subscriptionType ? { subscriptionType: subscription.subscriptionType } : {}) };
}

async function finish(host: Host, result: Json): Promise<void> {
  const operation = result.operation;
  if (!operation || operation.state === 'succeeded') return;
  for (let attempt = 0; attempt < 120; attempt++) {
    const state = await host.cli(['operations', 'get', operation.operation_id]);
    const status = state.operation?.state ?? state.state;
    if (status === 'succeeded') return;
    if (['failed', 'cancelled'].includes(status)) throw failure('HiRoute 配置操作失败，请重试。');
    await delay(250);
  }
  throw failure('HiRoute 配置超时，请重试。');
}

async function applyPreview(host: Host, preview: Json, key: string): Promise<Json> {
  const result = await host.cli(['compute', 'connection', 'apply'], {
    spec: preview.spec, accept_digest: preview.accept_digest,
    expected_revisions: preview.expected_revisions, idempotency_key: key,
  });
  await finish(host, result);
  return result;
}

async function saveCandidate(host: Host, candidate: Json, key: string, validation?: Json): Promise<void> {
  const models = candidate.models.filter((model: Json) => model.selectable !== false).map((model: Json) => model.model_ref);
  if (!models.length) throw failure('HiRoute 没有发现可路由的模型。');
  const current = await host.cli(['compute', 'list']);
  const preview = await host.cli(['compute', 'connection', 'preview'], { change: {
    schema: 'hiroute.compute-management-change/v2',
    subject: { kind: 'candidate', candidate: candidate.candidate }, expected_revisions: current.revisions,
    selected_model_refs: models, intent: 'save_ready', key_edits: [], ...(validation ? { validation } : {}),
  } });
  await applyPreview(host, preview, key);
}

async function importSubscription(host: Host): Promise<void> {
  const options = await host.cli(['compute', 'connection', 'options'], {});
  const candidates = options.subscriptions?.candidates ?? [];
  const claude = candidates.filter((entry: Json) => entry.provenance === 'connector_owned' && /claude/i.test(JSON.stringify(entry)));
  if (!claude.length) throw failure('HiRoute 无法发现当前 Claude 订阅，请重新登录 Claude 后重试。');
  for (const candidate of claude) {
    const preview = await host.cli(['compute', 'connection', 'preview'], { candidate: candidate.candidate });
    const applied = await applyPreview(host, preview, `subscription-check-${digest(candidate.candidate)}`);
    let checked: Json = {};
    for (let attempt = 0; attempt < 120; attempt++) {
      checked = await host.cli(['compute', 'connection', 'authorize'], { action: 'result', operation: applied.operation });
      if (checked.status !== 'checking') break;
      await delay(250);
    }
    if (checked.status !== 'verified' || !checked.validation || !checked.checked_candidate) {
      throw failure('HiRoute 无法验证 Claude 订阅，请先在 Claude 中重新登录。');
    }
    await saveCandidate(host, checked.checked_candidate, `subscription-save-${digest(checked.checked_candidate.candidate)}`, checked.validation);
  }
}

async function importConnection(host: Host, connection: ClaudeModelConnectionSecret): Promise<void> {
  const candidate = `candidate/native/chisa-${connection.id}`;
  const registered = await host.secret(candidate, connection.apiKey);
  const fact = (value: unknown) => ({ value, basis: 'user_declared' });
  const draft = {
    inference_model_id: null, candidate_ref: candidate, lineage_ref: `lineage/native/chisa-${connection.id}`,
    display_name: `Chisa connection ${connection.id}`, existing_source_id: null, edit_revision: 1, check_id: `check/native/chisa-${connection.id}`,
    base_url: connection.baseUrl, base_kind: 'native_messages_base', request_path_override: null,
    // Admission imports the user's existing configuration; it does not make a billable inference probe.
    inventory_path_override: null, protocol: 'messages', protocol_profile_id: 'profile/custom/messages',
    protocol_profile_revision: 1,
    authentication: connection.authType === 'api_key' ? { kind: 'api_key_header', header: 'x-api-key' } : { kind: 'bearer' },
    configuration_revision: 1,
    models: [{ upstream_model_id: connection.model, display_name: connection.model, catalog_configuration_id: null,
      membership: 'user_declared', capabilities: { tool: fact(true), vision: fact(false), streaming: fact(true),
        context_tokens: fact(200000), max_output_tokens: fact(64000), native_reasoning: fact({ kind: 'fixed', profile: 'provider-default' }) } }],
  };
  const checked = await host.cli(['compute', 'connection', 'test'], {
    kind: 'native', request: { draft, input_candidate: registered.candidate ?? { candidate_ref: candidate, candidate_revision: registered.candidate_revision ?? 1 } },
  });
  await saveCandidate(host, checked.candidate, `connection-save-${connection.id}`);
}

function priority(candidate: Json): number {
  const text = `${candidate.display_name} ${candidate.model_configuration_id}`.toLowerCase();
  return text.includes('opus') ? 0 : text.includes('sonnet') ? 1 : text.includes('haiku') ? 2 : 3;
}

async function publish(host: Host, subscriptions: Set<string>): Promise<Json> {
  const options = await host.cli(['routing', 'options'], {});
  const candidates: Json[] = (options.candidates ?? []).filter((entry: Json) => entry.routable && entry.ingress_protocols?.includes('messages'));
  const subscription = candidates.filter(entry => subscriptions.has(entry.binding_id)).sort((a, b) => priority(a) - priority(b));
  const native = candidates.filter(entry => !subscriptions.has(entry.binding_id));
  if (!candidates.length) throw failure('HiRoute 没有可用来源。请登录 Claude 或保存至少一个第三方模型连接。');
  const refs = (items: Json[]) => items.map(entry => ({ binding_id: entry.binding_id }));
  const editor = {
    schema: 'hiroute.plan-editor/v2', display_name: 'Chisa HiRoute', purpose: 'Automatically route saved models and the current Claude subscription',
    mode: 'smart_saving', candidates: [], smart: {
      economy: refs([...native, ...subscription]), primary: refs([...subscription, ...native]),
      judgment: { degree: { simple_threshold_millis: 800, instructions: 'Assess task complexity', simple: 'Routine work', complex: 'Complex reasoning and architecture' },
        competence: { floor_millis: 500, instructions: 'Assess task progress', criteria: ['Poor', 'Partial', 'Reliable'] } },
      reselect_on_user_message: true, classifier: { kind: 'local_rules' },
      complex_keywords: ['architecture', 'investigate', 'refactor', 'security', 'debug', '设计', '架构', '重构', '排查', '调试', '复杂', '分析'],
    }, free: { candidates: [], primary: [], primary_fallback: false }, delegation_enabled: false, requirements: {},
    limits: { maximum_attempts: Math.min(candidates.length, 8), request_timeout_ms: 180000, attempt_timeout_ms: 90000 },
  };
  const change = { schema: 'hiroute.plan-content-change/v2', target: { intent: 'create', creation_key: 'chisa-managed' }, editor, consumed_draft: null };
  const preview = await host.cli(['routing', 'preview'], { change });
  await finish(host, await host.cli(['routing', 'apply'], { change, accept_digest: preview.change_digest, expected_revisions: preview.expected_revisions, idempotency_key: 'chisa-managed-plan' }));
  const list = await host.cli(['routing', 'list']);
  const plan = list.plans?.find((entry: Json) => entry.desired?.display_name === 'Chisa HiRoute');
  if (!plan) throw failure('HiRoute 路由发布失败。');
  return plan;
}

async function connect(host: Host, plan: Json): Promise<HiRouteConnection> {
  const scan = await host.cli(['agents', 'scan']);
  const agent = scan.agents?.find((entry: Json) => entry.agent_id === 'agent_claude_default');
  if (!agent?.context_id) throw failure('HiRoute 无法建立隔离的 Claude 调用上下文。');
  const planId = plan.agent_plan_id;
  // Host owns an isolated HOME. These settings never target the user's native Claude configuration.
  const spec = { schema_version: { major: 2, minor: 0 }, context_id: agent.context_id,
    model: { intent: 'configure', settings: { mode: 'claude_launcher', surfaces: ['claude_cli'], fixed_models: [],
      preset_mappings: Object.fromEntries(['opus', 'sonnet', 'haiku'].map(key => [key, { kind: 'plan', plan_id: planId }])) } } };
  let preview = await host.cli(['agents', 'connect', 'preview'], { spec });
  if (preview.blockers?.some((blocker: Json) => blocker.capabilities?.some((capability: Json) =>
    capability.capability === 'ingress_authentication' && capability.reason === 'unknown'))) {
    // The admitted native-authentication check uses an isolated loopback challenge
    // against the real Claude CLI, with no provider inference request.
    await host.cli(['agents', 'check', 'agent_claude_default', '--scope', 'native-authentication', '--suite', 'quick']);
    preview = await host.cli(['agents', 'connect', 'preview'], { spec });
  }
  if (!preview.applicable || preview.blockers?.length) throw failure('HiRoute Claude 调用上下文暂不可用。');
  await finish(host, await host.cli(['agents', 'connect', 'apply'], {
    spec: preview.spec, accept_digest: preview.accept_digest, expected_revisions: preview.expected_revisions,
    dependency_digest: preview.dependency_digest, idempotency_key: `chisa-agent-${digest(preview.accept_digest)}`,
  }));
  const gateway = await host.cli(['gateway', 'show']);
  const baseUrl = typeof gateway.connect_address === 'string' ? `http://${gateway.connect_address}` : '';
  if (!gateway.ready || !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(baseUrl)) throw failure('HiRoute 本地网关尚未就绪。');
  return { enabled: true, baseUrl, routeModel: plan.head?.model_alias ?? plan.model_alias, authToken: await host.grant(agent.context_id) };
}

async function prepare(userId: number, signal?: AbortSignal): Promise<HiRouteConnection> {
  signal?.throwIfAborted();
  let snapshot: ClaudeAccountLaunchSnapshot | null = null;
  try { snapshot = claudeAccountsService.captureLaunch(userId); }
  catch (error) {
    // An unavailable subscription must not block explicitly saved HiRoute API sources.
    if (!['CLAUDE_ACCOUNT_SIGN_IN_REQUIRED', 'CLAUDE_ACCOUNT_IN_USE'].includes((error as AppError).code ?? '') || !claudeConnectionsDb.list(userId).length) throw error;
  }
  let retained = false;
  try {
    const result = await prepareWithSnapshot(userId, snapshot, signal);
    // The host may retain this source while other requests are using its gateway.
    if (snapshot) leases.get(userId)!.accountReleases.push(snapshot.release);
    retained = true;
    return result;
  } finally { if (!retained) snapshot?.release(); }
}

async function prepareWithSnapshot(userId: number, snapshot: ClaudeAccountLaunchSnapshot | null, signal?: AbortSignal): Promise<HiRouteConnection> {
  const connections = claudeConnectionsDb.list(userId);
  const subscription = await readSubscription(userId, snapshot);
  if (!connections.length && !subscription) throw failure('HiRoute 需要可用的 Claude 登录或已保存的第三方模型连接。请先登录或添加连接。');
  // Credential material is hashed, never included in process arguments or diagnostic output.
  const generation = digest({ connections, subscription: subscription ? { accessToken: subscription.accessToken } : null });
  const host = await createHiRouteHost(userId, generation, {}, signal);
  const lease = leases.get(userId) ?? { count: 0, hosts: new Map<string, Host>(), accountReleases: [] };
  lease.hosts.set(generation, host);
  leases.set(userId, lease);
  try {
    await host.ensure();
    await host.bridgeCredentials(subscription ? JSON.stringify({ claudeAiOauth: subscription }) : null);
    signal?.throwIfAborted();
    const current = await host.cli(['routing', 'list']);
    let plan = current.plans?.find((entry: Json) => entry.desired?.display_name === 'Chisa HiRoute');
    if (!plan) {
      const existing = await host.cli(['compute', 'list']);
      // Failed initialization can be retried without duplicating already saved sources.
      const sources: Json[] = existing.sources ?? [];
      if (subscription && !sources.some(source => source.provenance === 'connector_owned')) await importSubscription(host);
      const refreshed = await host.cli(['compute', 'list']);
      const subscriptions = new Set<string>((refreshed.sources ?? []).filter((source: Json) => source.provenance === 'connector_owned')
        .flatMap((source: Json) => source.models.map((model: Json) => model.binding_id)));
      for (const connection of connections) {
        signal?.throwIfAborted();
        if (!sources.some(source => source.provenance === 'user_configured' && source.display_name === `Chisa connection ${connection.id}`)) await importConnection(host, connection);
      }
      plan = await publish(host, subscriptions);
    }
    signal?.throwIfAborted();
    const connection = await connect(host, plan);
    lease.count++;
    return connection;
  } catch (error) {
    if (lease.count === 0) {
      for (const instance of lease.hosts.values()) await instance.dispose().catch(() => undefined);
      leases.delete(userId);
    }
    throw error;
  }
}

/** Claude runtime releases its successful request lease after SDK completion; the last request stops managed daemons. */
export async function releaseManagedHiRoute(userId: unknown): Promise<void> {
  const id = requireConnectionUserId(userId);
  await serialized(id, async () => {
    const lease = leases.get(id);
    if (!lease) return;
    lease.count--;
    if (lease.count > 0) return;
    leases.delete(id);
    for (const host of lease.hosts.values()) await host.dispose().catch(() => undefined);
    for (const release of lease.accountReleases) release();
  });
}

/** Claude runtime prepares the selected per-user managed gateway; ordinary model requests never call this. */
export async function prepareManagedHiRoute(userId: unknown, signal?: AbortSignal): Promise<HiRouteConnection> {
  const id = requireConnectionUserId(userId);
  signal?.throwIfAborted();
  return serialized(id, () => prepare(id, signal));
}
