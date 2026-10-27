# 会话工作区与隔离元数据持久化审查报告

> 审查范围：`server/modules/database`、`server/modules/providers`、`server/modules/websocket`、`server/modules/workspace-bridge`，以及会话创建 API 和前端 API 类型。本文记录审查结论与已落地的最小修复；隔离策略的完整持久化字段仍需后续单独演进。

## 结论

应把“会话请求的工作区/隔离配置”持久化在 `sessions` 领域，由会话服务在创建会话时完成校验、规范化和写入；项目表只保存可复用的项目身份与项目级展示属性；正在运行的进程、socket、同步租约、当前连接和事件缓冲继续留在运行时注册表或其他临时状态中。

当前最合适的落点是扩展 `sessions` 表及其 repository/service，而不是把信息放入 WebSocket 帧、前端状态、`projects` 表或 `chatRunRegistry`。新会话先写入稳定的 app `session_id`，随后每次 `chat.send` 只接收 `sessionId`，从数据库重新解析 provider、项目和隔离配置，再把受服务端控制的运行参数传给 provider runtime。这样可以跨页面刷新、进程重启、provider-native session id 延迟产生和 WebSocket 重连保持一致。

推荐将持久数据拆成三层：

1. **请求配置（durable intent）**：用户创建会话时选择的执行模式、是否只读、隔离策略、项目引用、必要的版本/配置标识。
2. **已解析资源（durable resolution，可选但建议）**：实际绑定的工作区根目录、worktree 路径、分支或容器/沙箱标识，以及解析时间和状态。它用于恢复、清理和诊断，不能替代每次运行前的安全校验。
3. **运行时租约（ephemeral）**：PID、WebSocket、同步锁、`WorkspaceLease`、AbortController、事件缓冲、当前 run id。这些不应作为会话的持久真相写入 `sessions`，应由运行时 registry 管理，并在启动/恢复时重新建立。

## 现有数据与调用链

### 项目与会话数据库

`server/modules/database/schema.ts` 的 `projects` 表以 UUID `project_id` 为主键，以规范化后的 `project_path` 唯一标识路径，并保存名称、星标和归档状态。`sessions` 表目前以 `session_id` 为主键，保存 provider、延迟产生的 `provider_session_id`、标题、`project_path`、transcript 路径、model、effort、fork 来源和时间/归档字段。外键仍是 `(project_path) REFERENCES projects(project_path)`。

`projectsDb.createProjectPath()` 会规范化路径并按路径创建或重新激活项目。`sessionsDb.createAppSession()` 会先确保项目行存在，再插入 app 分配的会话行，且将 `provider_session_id` 留空。provider 运行中产生 native id 后，由 `assignProviderSessionId()` 合并/记录映射。provider 同步器发现磁盘会话时，`createSession()` 以 provider id 为外部发现会话的初始 app id。

这套设计已经明确区分了两个身份：

- `session_id`：CloudCLI 对外稳定、可用于路由和 WebSocket 的会话身份。
- `provider_session_id`：Claude/Codex 等 provider 的 native transcript/runtime 身份。

隔离配置若依附 provider id，会在新会话首次运行前无处保存，也会在 provider id 变更或同步发现时发生错配，因此必须依附稳定的 `session_id`。

### 创建会话 API

前端 `src/shared/api.ts` 已有 `providers.createSession({ provider, projectPath, initialMessage? })`，调用 `POST /api/providers/sessions`。路由在 `server/modules/providers/provider.routes.ts` 中保持薄层，只读取 body 并调用 `sessionsService.createAppSession()`。

`sessions.service.ts` 当前流程是：trim `projectPath`、生成 `randomUUID()`、从初始消息生成不超过四个词的标题、调用 `sessionsDb.createAppSession()`，返回 `{ sessionId, provider, projectPath, sessionName }`。因此这里是添加 workspace/isolation 输入、调用共享路径校验、构造默认配置和返回规范化结果的最佳服务边界；路由不应自行解析路径或直接写数据库。

需要同步考虑 fork：`forkSessionById()` 当前复制 provider、项目路径、标题、model/effort 和 transcript，并写 `forked_from_session_id`。如果隔离配置代表会话语义，fork 应明确采用“复制源配置后允许覆盖”的规则；若 fork 只是同一项目下的独立会话，则不能意外复用源会话的已解析 worktree 目录、容器 id 或租约。

### WebSocket 入口与运行时

`createWebSocketServer()` 通过同一个 `ws` 服务分派 `/ws`、`/shell`、`/desktop-notifications` 和 `/plugin-ws/*`。聊天连接先通过 WebSocket 身份验证，再进入 `handleChatConnection()`。

`chat.send` 和 `chat.edit-send` 的共同路径 `resolveSendTarget()` 只接受客户端的 `sessionId`，随后从 `sessionsDb.getSessionById()` 解析 session。provider、项目路径和 provider-native id 均来自数据库；未知会话、无 runtime provider、并发运行都会在此处被拒绝。`dispatchRun()` 再构造 runtime options：

- `sessionId` 使用稳定 app id；
- `cwd` 和 `projectPath` 均由 `session.project_path` 生成，客户端传入的 cwd 不再覆盖服务端会话路径；
- model、effort、attachments 和 abort signal 也在此处拼装。

对于 workspace/isolation 需求，`clientOptions.cwd` 不能拥有覆盖服务端 session 配置的优先级。当前 `dispatchRun()` 已从已加载的 session row 同时生成 `cwd` 和 `projectPath`，客户端传来的 cwd 被忽略；因此同一个 `sessionId` 不会因不同客户端而切换 provider 工作目录。完整的隔离策略字段仍需要后续数据库演进。

`chatRunRegistry` 以 app session id 保存运行中的 run、provider、native id、连接、生命周期阶段和有限事件缓存，完成 run 后约五分钟清理。这是正确的短生命周期位置，但它不适合保存会话意图或重启后必须恢复的工作区信息。

## 现有 workspace/isolation 机制

`server/modules/workspace-bridge/workspace-bridge.service.ts` 已存在一套重要但目前主要依赖运行时和文件 marker 的机制：

- binding 包含 `root`、bridge port/token、binding epoch、协议能力、`isolated` 和可选 `sessionId`。
- `workspaceQuery()` 从 provider runtime options 读取 `chisaSessionId`/`sessionId`，随后删除内部字段，避免把它直接暴露给 SDK。
- VPS 且可写的运行在第一次 query 时调用 `createSessionWorktree(binding, sessionId, signal)`；该函数以 session id 生成稳定 worktree 名称，创建 `chisa/session/<name>` 分支，写入 workspace marker 和 metadata 文件，然后将 `options.cwd` 切到隔离目录。
- 如果已经是 isolated binding，则复用；若 metadata 不匹配，会返回冲突，要求从 Worktrees 恢复。
- 非隔离 VPS 运行另有 `claimWorkspace()`、`sync_begin`/`sync_end` 和清理流程，这些属于运行时租约。
- `permissionMode === 'plan'` 被作为只读会话的当前判定，workspace tools 会对只读运行拒绝写入和 preview 控制。

这证明隔离已经具有 session 级语义，但持久化边界不完整：session id 和 worktree metadata 文件之间存在隐式关联，数据库不会告诉恢复逻辑“该会话请求过哪种执行模式”、worktree 是否已解析、资源是否可回收，也不能可靠地在数据库查询中列出所有隔离会话。marker 文件可以作为工作区资源的恢复证据，却不应成为会话配置的唯一来源。

CLI 的 `sandbox` 服务目前是独立的命令封装，支持 workspace、agent、name、port、template、环境变量和 create/ls/start/stop/rm 等子命令。它不等同于聊天 session persistence；如果未来聊天会话使用 Docker sandbox，应保存一个受限的 sandbox profile/name/id 引用，而不是把完整 secrets、环境变量或可执行命令原样放入会话 JSON。

## 推荐的数据模型

### 第一阶段：扩展 sessions 表，保持迁移可控

在 `sessions` 增加明确的 session-level 字段，优先使用结构化列以便查询、约束和清理：

```sql
execution_mode TEXT NOT NULL DEFAULT 'project'
-- project | isolated_worktree | sandbox（按实际 provider 能力裁剪）

workspace_policy TEXT NOT NULL DEFAULT 'writable'
-- writable | read_only | plan

workspace_root TEXT
-- 规范化、服务端验证后的宿主工作区根目录；可为空表示 provider 默认

resolved_workspace_path TEXT
-- 实际解析出的 worktree/挂载工作目录；可为空，首次运行时延迟创建

isolation_ref TEXT
-- worktree name/branch 或 sandbox id 的不透明引用，不保存 secret

isolation_state TEXT NOT NULL DEFAULT 'unresolved'
-- unresolved | ready | stale | cleanup_pending | failed

isolation_metadata_json TEXT
-- 只放非敏感、版本化的 provider-specific 解析信息

isolation_resolved_at DATETIME
```

命名可按现有项目风格调整，但要避免将 `cwd` 作为唯一字段：cwd 是运行时结果，`workspace_root`/policy 才是输入意图。若字段数量过多，可先用 `workspace_config_json`（版本化 JSON）保存请求配置，再单独保留 `resolved_workspace_path`、`isolation_ref`、`isolation_state` 这几个需要筛选和清理的列。不要把整个配置塞进前端 localStorage 或 WebSocket memory。

### 第二阶段：将项目引用升级为 project_id

当前外键通过 `project_path` 关联，路径更新依靠 `ON UPDATE CASCADE`。它可继续工作，但对 session isolation 不够稳健，因为路径是可变资源位置，且 session 查询需要先按字符串解析。若允许一次 schema migration，建议在 sessions 增加 nullable `project_id` 外键并逐步迁移：

1. 以现有 `project_path` 回填 `project_id`。
2. 新写入优先保存 `project_id`，同时短期保留 `project_path` 兼容 provider 同步和旧数据。
3. 所有 filesystem/provider 调用通过 `projectsDb.getProjectPathById()` 得到当前规范化路径。
4. 旧 provider discovered rows 先按路径归属项目，再补齐 project id。
5. 稳定后再考虑移除 session 上的冗余 path 或将其降为缓存字段。

如果当前任务只需要新增隔离 metadata，不应为了这项功能强行一次性删除 `project_path`；可以先增加 `project_id` 和兼容回填，降低迁移风险。

### 不建议的模型

- **写入 projects 表**：同一项目可以有多个会话、不同只读/隔离策略和不同 worktree；项目级字段会造成会话之间相互覆盖。
- **只写 `chatRunRegistry`**：进程重启、WebSocket 重连和静态会话详情都会丢失。
- **只写 worktree marker**：无法表达用户请求的 policy、无法按 session 查询、清理与 DB 生命周期脱节。
- **让客户端每次发送 cwd/isolation**：会绕过后端创建时的授权和路径验证。
- **把 PID、port、token、lease id 持久化为 session 真相**：这些都是短期资源，重启后可能复用或失效，且 token 属于敏感信息。

## 建议的调用顺序

1. `POST /api/providers/sessions` 接收 `provider`、项目标识、可选 `workspace`/`isolation` 配置。
2. route 仅做输入解包；service 校验 provider 能力、规范化项目路径、校验 workspace root 必须位于允许根目录且不命中系统/危险 symlink，并规范化默认 policy。
3. service 通过 `sessionsDb.createAppSession()` 写入 session 配置，返回稳定 `sessionId` 和规范化配置摘要。若配置要求立即创建资源，则在同一 service 中调用 isolation provisioner；否则返回 `unresolved`。
4. 首次 `chat.send` 通过 session id 重新加载 session 行，验证 session 未归档、项目仍存在、workspace path 仍满足安全策略、执行模式仍受 provider 支持。
5. runtime gateway 接收服务端构造的 `RuntimeWorkspaceContext`，其中包含 session id、provider、project id/path、policy、requested mode 和可选 resolved ref；provider adapter 不读取客户端原始 cwd。
6. `workspaceQuery()` 使用 context 中的 session id 做 worktree 恢复/创建。创建成功后更新 resolved path/ref/state；更新必须幂等，且对 session 并发运行有唯一约束或事务保护。
7. run 完成时仅释放 lease、同步状态和连接；不要自动删除 session 配置。删除/归档 session 时由专门 cleanup service 根据 state/ref 清理 worktree/sandbox，并保留失败状态可重试。
8. session details API 返回 requested mode、read-only policy、resolved state 和可展示的 workspace label/path；隐藏 token、内部端口、命令环境变量和其他敏感字段。

## API 与类型建议

创建请求可以向后兼容地扩展为：

```ts
type CreateSessionInput = {
  provider: LLMProvider;
  projectId?: string;
  projectPath?: string; // 迁移期间兼容旧客户端；后端规范化并优先解析 projectId
  initialMessage?: string;
  workspace?: {
    mode?: 'project' | 'isolated_worktree' | 'sandbox';
    policy?: 'writable' | 'read_only' | 'plan';
    rootPath?: string;
    template?: string; // 只允许 provider/服务端白名单值
  };
};
```

返回值应包含稳定 id 和非敏感的规范化结果，例如：

```ts
type CreateSessionResult = {
  sessionId: string;
  provider: LLMProvider;
  projectId: string | null;
  projectPath: string | null;
  sessionName: string;
  workspace: {
    mode: 'project' | 'isolated_worktree' | 'sandbox';
    policy: 'writable' | 'read_only' | 'plan';
    state: 'unresolved' | 'ready' | 'stale' | 'cleanup_pending' | 'failed';
    path: string | null;
  };
};
```

`chat.send` 的 `options` 可以继续携带 model/effort/attachments 等 turn 级选项，但 workspace/isolation 应从 session metadata 读取。若必须支持临时覆盖，应定义明确的白名单字段和权限校验，并记录是否覆盖；不得接受任意 `cwd`、任意 host path、任意 Docker template 或任意环境变量。

## 安全与一致性检查

- 所有路径在 create-session 和每次运行前都调用已有的 allowed-root、系统关键路径、规范化和 symlink 检查；不能只依赖前端选择器。
- session details、REST 列表和 WebSocket lifecycle event 只发送展示所需的相对路径/标签；不发送 bridge token、sandbox secret、内部端口或完整环境变量。
- `provider_session_id` 仍只用于 provider transcript resume，不要让 provider native id 成为 workspace/isolation 的主键。
- app session 尚未获得 provider id 时也必须拥有完整的 workspace intent；provider sync/update 只能更新 provider artifact 字段，不能用磁盘扫描结果覆盖用户选定的 isolation policy。
- fork 时复制 requested config，但重新生成 resolved ref；如果源是 isolated worktree，fork 不应指向同一个 mutable worktree，除非产品明确要求共享且实现并发锁。
- 归档不应立即删除可恢复的配置；强制删除项目时，要先枚举所有 session，包括 archived rows，再清理 worktree/sandbox 资源，并处理 cleanup 失败重试。
- worktree 创建必须幂等并防止同一 session 并发创建两个 branch/目录。数据库状态更新与 marker 写入应设计可恢复顺序：先标记 provisioning，成功后 ready，失败后 failed/cleanup_pending。
- schema migration 要兼容旧 sessions：旧行默认 `execution_mode='project'`、policy 按现有行为映射、state 为 `unresolved`，不能因缺少新字段阻断历史会话打开。

## 验证计划

这是只读架构审查，未运行构建或测试，也未修改既有源文件。实现阶段至少应覆盖：

- 新建会话写入并返回规范化 workspace/isolation metadata；provider id 为空时仍可发送第一条消息。
- WebSocket 只使用 DB session metadata；客户端发送不同 cwd 不得改变执行目录。
- page refresh、WebSocket reconnect 和 server restart 后，session details 与 isolated worktree 能恢复。
- fork 会复制 policy 但不会共享 mutable resolved worktree；provider sync 不会覆盖 policy。
- path traversal、系统目录、越过 allowed root 的 symlink、无效 provider mode 都被拒绝。
- 同一 session 并发 `chat.send` 只有一个 run 和一个 worktree；abort、失败、进程重启后状态可恢复或进入可重试状态。
- archived/project deletion 与 worktree/sandbox cleanup 的数据库和文件系统状态最终一致。

## 关联代码位置

- `server/modules/database/schema.ts`：projects/sessions schema。
- `server/modules/database/repositories/sessions.db.ts`：app session 创建、provider id 合并、按项目查询。
- `server/modules/providers/services/sessions.service.ts`：创建/ fork 会话的 service 边界。
- `server/modules/providers/provider.routes.ts`：`POST /api/providers/sessions` 薄路由。
- `server/modules/websocket/services/websocket-server.service.ts`：统一 WebSocket 路由入口。
- `server/modules/websocket/services/chat-websocket.service.ts`：按 session id 解析并构造 runtime options。
- `server/modules/websocket/services/chat-run-registry.service.ts`：仅运行时 run registry。
- `server/modules/workspace-bridge/workspace-bridge.service.ts`：binding、session worktree、workspace lease 和 provider tools。
- `server/shared/utils.ts`：workspace root、系统关键路径、规范化和 symlink 安全校验。
- `src/shared/api.ts`：创建 session 请求 helper。
