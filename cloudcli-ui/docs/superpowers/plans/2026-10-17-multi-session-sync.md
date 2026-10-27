# 多会话同步改造计划

## 1. 原生解绑与 cloud-only 恢复

- 先以失败测试固定：无本地 mapping 的 VPS 项目返回 `unbound` 并可发送；同步终止或远端 lease 清理失败时保留 mapping/marker。
- 将解绑流程改成“检查活动任务 → 精确终止同步 → 确认远端清理 → 删除 marker → 删除本地 mapping”的原子顺序。
- 复用 durable release journal、binding epoch 和 owner 检查，避免旧会话删除新绑定。

## 2. 只读会话与共享写入锁

- 只读/计划模式跳过项目级写入 lease，不触发本地同步排队。
- RPC 工具在只读模式拒绝写文件、非只读命令和预览控制；读操作继续使用现有 VPS worker。
- 前端 composer 只对需要共享写入的会话等待同步状态，不再把另一个会话的 `reserved` 视为全局阻塞。

## 3. 写入会话隔离与手动合并

- Git 同步项目按会话创建独立 worktree/container，并将执行路径与会话绑定。
- 会话完成后保留 worktree，使用现有 Worktrees 入口查看、比较和手动合并；不自动覆盖主项目。
- 合并前由用户在保留的 worktree 中检查并提交改动；未提交状态保持可见，不自动替用户合并。
- 非 Git 目录只有在具备真实 copy-on-write/container 隔离时才并行写入；否则保持共享写入排队并返回明确状态。

## 4. 验证与交付

- 运行原生、服务端和前端的聚焦回归测试，再运行受改动影响的 typecheck/build/lint。
- 用真实客户端路径检查：第二会话、只读会话、worktree 留存/手动合并入口、解绑失败保留状态、解绑成功后的 cloud-only 发送。
- 做 Standards + Spec 代码评审；不创建 PR、不推送，等待用户明确授权。

