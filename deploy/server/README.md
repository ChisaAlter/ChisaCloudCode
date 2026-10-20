# 服务端容器部署（cloudcli-ui）

`Dockerfile` 从仓库根目录构建 ChisaCloudCode 服务端镜像，`compose.example.yaml` 是对应的 compose 示例（路径、端口按实际服务器调整；密钥放在 0600 的 `api.env`，不要提交）。

```sh
docker build --memory 8g --build-arg COMMIT=$(git rev-parse HEAD) \
  -f deploy/server/Dockerfile -t local/chisacloudcode:<tag> .
CCC_TAG=<tag> docker compose -f compose.yaml up -d
```

## Claude Code CLI

- 镜像把 Agent SDK 自带的原生二进制（`@anthropic-ai/claude-agent-sdk-linux-{x64,arm64}[-musl]/claude`）链接到 `/usr/local/bin/claude`。网页「Claude CLI Login」和 Shell 页都在 PTY 里直接执行 `claude`，所以必须在 PATH 上。找不到对应平台的二进制时构建直接失败。
- API 容器以 root 运行（需要管理宿主机 docker）。Claude Code 在 root 下默认拒绝 `--dangerously-skip-permissions` / bypassPermissions，除非 `IS_SANDBOX=1`。容器本身就是隔离边界，因此镜像设置 `ENV IS_SANDBOX=1`；服务端代码在以 root 运行且未设置 `IS_SANDBOX` 时也会给 Claude 子进程补上 `IS_SANDBOX=1`。显式设置的值（例如 `IS_SANDBOX=0`）不会被覆盖。
- Claude 登录凭据写在 `HOME`（示例为 `/opt/chisacloudcode/home`，持久化挂载）。

## 升级

从同一发布标签构建客户端与服务端。容器构建使用完整的 `COMMIT` 参数，把来源提交写入 Web、服务端构建身份和镜像标签。构建上下文只应包含该提交的源码。

升级前等待正在运行的任务完成，备份数据库、会话目录及部署配置，保留旧镜像；用独立数据库/目录验证新镜像，再切换生产容器。沿用原有持久化挂载与环境配置，重启后检查 `/health`、登录、项目列表和一次任务交还。

发布提供的 Linux x64 服务端归档包含 Web、编译后的服务端、运行资源和锁文件。解压后使用 Node.js 24 执行 `npm ci --omit=dev`，并按现有服务管理方式启动。原生依赖必须在目标 Linux 平台安装；不能把 Windows 的 `node_modules` 复制到 VPS。

已有项目中的暂存内容或未完成 Git 操作不会因升级自动解决。初次无共同 Git 检查点且两端分支不同时，客户端会提供恢复预览，由用户选择安全来源；恢复前应保留双方备份。
