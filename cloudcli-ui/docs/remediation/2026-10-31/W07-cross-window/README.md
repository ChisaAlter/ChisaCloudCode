# W07 cross-renderer preference outbox

2026-11-01，工作目录 `C:\AI\ChisaCloudCode\cloudcli-ui`。此次仅增强跨 renderer outbox 根因，保留接手时的 dirty 工作区；没有安装依赖、全量测试、完整构建，也没有修改 Auth authority、API 或 shared types。

## 结果与边界

[最终窄回归](final-narrow.log) **92/92 通过**：原 outbox 40、新增跨 renderer 18、下游消费者 34。后者包括 editor persistence 13、editor sync 6、Settings controller 6、Settings sync status 9（Lead 同时增强后从原计数增加）。[最终 lint](lint-final.log) 5 个授权文件 0 warning / 0 error；[focused TypeScript](typecheck-final.log) 同 5 文件语法、语义诊断均为 0。仅检查指定文件的 diagnostics，依赖照常加载；这不是全仓 typecheck。

[源文件 SHA-256](source-sha256.txt) 保存最终实际验证源及依赖合同指纹。接手时 outbox 源 SHA-256 为 `533a3a07e9d89f39579638c48431352378d649caeaafd2b8f296b37618355e32`，原 40 项测试为 `0fd27fb138df926bece673ef1a9a9c4f13276d587f71d201aeb26d32f9dc0146`。仓库原本包含大量其他任务的未提交变更；没有 reset、清理或改写其他 owner 的变更。

## 根因

原 [outbox 实现](../../../../src/shared/userSettings.ts) 每个 renderer 各自缓存整份 server/user 分区，再由 edit、hydrate、dispatch、ACK、retry 直接 localStorage.setItem 整份覆盖。两个窗口可以同时从相同 revision 起点编辑，导致不同字段丢写；旧 ACK 又能把另一窗口的 pending 覆盖成 clean，两个 dispatcher 也能同时发送同一 outbox。原单 renderer 串行机制不能为跨窗口提交建立顺序。

## 修复合同

- 有 Web Locks：同一 server/user 的每次持久 mutation、派发 claim、ACK 和 hydrate merge，都在同一 exclusive preference lock 内同步完成 read → normalize/recover → mutate → setItem。锁名使用已分区的 storage key。不得在该回调中等待 Auth、fetch、响应 JSON 或任何网络。Auth authority 有独立锁，API 在 preference lock 释放后才做真实 admission。
- 同字段 **last committed transaction wins**；revision 在锁内从最新共享字段时钟分配，不以窗口时钟或编辑开始时刻排序。不同字段从最新共享 blob 合并。本窗口未提交 draft 立即反映到同步 reader，锁提交后按最新 authority 重新合并镜像。
- 同值优化也在锁内验证最新共享值。遗漏 storage hint 的旧 renderer 不能因为自己的陈旧镜像刚好等于输入，就吞掉用户的显式新编辑。已 clean 且 authority 确认同值的编辑仍不发 PATCH。
- claim 同时持久化 lease owner、随机 lease id、expiresAt 和精确 inFlight revision。活跃 lease 存在时另一个 renderer 不重复派发。网络不持 Web Lock。每个 HTTP 保存有 10 秒 timeout；lease 为 15 秒。其它观察者在 lease 到期设 timer 唤醒，故即使 dispatcher 崩溃且没有后续 storage 事件，也能恢复已经观察到的 lease。异常未来 lease 会被限制在观察时起 15 秒内。
- 恢复仅重放每个字段的最新 committed revision。若 crashed inFlight 为 v1、pending 已经是 v2，只发送 v2。旧无 lease v2 格式的 inFlight 也可在第一次受锁观察时恢复。
- 2xx 只能 ACK **自己的 lease id、owner 与自己的字段 revision**。新 edit supersedes 旧 batch 后仍 dirty；过期 lease 被其它 renderer 接管，即便重放的 field revision 恰巧相同，旧 2xx 也不能清除新 lease 或 ACK 新 batch。错误/次数/Retry-After 保留在共享分区，handoff 不会重置重试预算。
- hydrate 在 GET 前后分别做短事务；记录字段 revision、初始 dirty 字段，并在结果提交时再读最新 authority。编辑、ACK 后字段值、另一个 hydrate 的已提交值均不会被较早 GET 覆盖。hydrate 更新同样推进 clean 字段时钟，以拒绝其它在其前启动的 GET。
- storage 事件 **仅 wake**：忽略 newValue，受锁重新读取存储。没有 cached whole-blob 回写路径。
- 派发和 GET 均传捕获的 expectedSession；真实 API/Auth admission 可拒绝过期 owner。不会在异步等待后用新账号 token 发送旧账号 patch。
- 无 Web Locks：整个可变 outbox 使用每窗口 sessionStorage，保持 server/user 分区；不读取共享 localStorage 分区作为 fallback，不共享 mutable blob。设备 appearance 仍可用 localStorage；只有显式匹配 server/user 的 legacy owner marker 才可迁移旧值，未知归属 legacy 永不进入账号 outbox。无锁模式不提供跨窗口统一排序/去重，也不在关闭整个窗口后保留 outbox。
- 存储拒绝：保留本 renderer 内存中的 dirty 内容，并展示 persistenceError。不会回读旧 blob 覆盖 dirty，也不会从 sessionStorage 失败转而写共享 localStorage。持久性和跨 renderer 协调无法在存储不可用时保证，因此即使 HTTP ACK 到达仍保留可见 failed 状态。

## 实际修改范围

- [userSettings.ts](../../../../src/shared/userSettings.ts)：跨 renderer factory、短事务、同步 draft overlay、有界 dispatcher lease/timeout、精确 ACK、hydrate 合并、storage wake、sessionStorage fallback。
- [userSettings.test.ts](../../../../src/shared/tests/userSettings.test.ts)：保留原 40；仅让 partition fixture 跟随锁能力选择存储，以及把旧账号数据泄露检查限定在数据而非新增 revision 字段名上。
- [userSettings.crossRealm.test.ts](../../../../src/shared/tests/userSettings.crossRealm.test.ts)：新增 18 个确定性 factory 并发/恢复用例。
- [codeEditorSettingsPersistence.test.ts](../../../../src/modules/settings/tests/codeEditorSettingsPersistence.test.ts)、[codeEditorSettingsSync.test.ts](../../../../src/modules/code-editor/tests/codeEditorSettingsSync.test.ts)：仅调整 partition 读取 storage 的 fixture。
- [settingsControllerCodeEditor.test.ts](../../../../src/modules/settings/tests/settingsControllerCodeEditor.test.ts) 的 partition seed/read 由 Lead owner 修正；本 worker 只报告问题并纳入验证。Settings 产品及 controller 产品由 Lead 维护。

## 测试证据

新增并发夹具创建两个独立 preference factory、两个真实 `createAuthSessionStore` authority、独立 sessionStorage / EventTarget、共享受序列化 LockManager 与 storage。没有把 `isCurrent` 模拟成固定 true；transport 使用捕获 expectedSession 进入真实 authority.dispatch。

18 项覆盖：不同字段 barrier merge / 单派发、同字段提交排序 / stale ACK、hydrate 与远端编辑和 ACK、竞争 hydrate、dispatcher crash、全部窗口 crash/reopen、HTTP timeout、伪造 storage payload、无锁窗口隔离、共享存储拒绝、session 存储拒绝、旧 owner admission、legacy inFlight 恢复、异常未来 lease、遗漏 storage hint 的同值新编辑、共享 401/rotation、过期 lease 接管后的旧 completion、Retry-After 与次数交接。夹具断言 preference lock callback 返回同步值，且 HTTP save 不处在 preference lock 内。

```powershell
node node_modules/vitest/vitest.mjs run src/shared/tests/userSettings.test.ts src/shared/tests/userSettings.crossRealm.test.ts src/modules/settings/tests/codeEditorSettingsPersistence.test.ts src/modules/code-editor/tests/codeEditorSettingsSync.test.ts src/modules/settings/tests/settingsControllerCodeEditor.test.ts src/modules/settings/tests/preferenceSyncStatus.test.tsx --maxWorkers=1 --minWorkers=1
node node_modules/oxlint/bin/oxlint src/shared/userSettings.ts src/shared/tests/userSettings.test.ts src/shared/tests/userSettings.crossRealm.test.ts src/modules/settings/tests/codeEditorSettingsPersistence.test.ts src/modules/code-editor/tests/codeEditorSettingsSync.test.ts --deny-warnings
```

最终测试 stderr 中的 `Error saving notification preferences` 来自 consumer 的预期失败注入；该测试及 runner exit code 均通过。前期 [原 outbox 诊断](original-outbox.log)、[第一轮跨窗口诊断](outbox-cross-window.log)、[锁夹具诊断](cross-window-diagnostic.log)、[旧 consumer fixture 失败](consumer30.log) 保留供审计；以 final 日志及 source hash 为最终结论。日志已统一为 UTF-8。

## 明确限制

1. **客户端 lease 无法替代服务端 revision fence。** 当前 [savePreferences API](../../../../src/shared/api.ts) 是无 revision/idempotency key 的幂等设置 merge PATCH。crash 前已被服务器接收、但无限延迟执行的旧请求，在新请求之后执行仍可能覆盖服务器的新值；客户端 abort 不是服务端回滚，也不能提供 exactly-once。已通知 Lead：若目标包括该强顺序保证，需在服务端/API 加条件 revision/fencing 或幂等操作协议。本改动保证正常 dispatcher 的串行、客户端精确 ACK 与恢复时只选择最新 committed 字段，不能证明不可观测的服务端历史请求永不迟到。
2. factory 测试明确模拟两个独立 renderer 的状态、authority 和存储，没有启动两个真实 Chromium renderer / 原生窗口。LockHost 将读写都序列化，是对生产 exclusive preference lock 的确定性模型；真实浏览器 Web Locks、原生 bridge、跨设备传播不在此次实际验证范围。
3. lease 和 timeout 使用浏览器 timer/Date.now；挂起窗口的恢复由仍在运行的观察者或重开页面执行，所有窗口均冻结时不会在真实墙钟上运行 JS。请求 timeout 后的 replay 允许幂等重复请求。
4. 无 Web Locks 的 fallback 刻意隔离窗口；不消费既有共享 outbox，避免无锁读改写。用户需在原窗口继续发送其 session outbox，或使用有 Web Locks 的环境恢复原共享分区。sessionStorage 在整窗口关闭后按浏览器语义清除；浏览器 duplicate-tab 可能复制初始 sessionStorage，后续仍互相隔离。
5. 存储不可用后本 renderer 保持 memory-only failed 直到重载，不声称恢复持久性；跨 renderer 去重/merge 在此条件下不可保证。
6. 未执行全量 client/server suite、完整 build、全仓 typecheck；本任务明确限定窄验证。Auth/API/Settings 等并行变更的哈希记录是验证时快照，其后由其它 owner 的修改需要对应 owner 再验证。
