# ChisaCloudCode

在 Windows 桌面使用云端 AI 编程工作区。MyGo 提供原生桌面壳，Claude Code、Codex 等模型服务在 VPS 运行；文件、Git、终端和预览默认使用云端工作区，也可显式连接现有 Windows 目录作为 SSH 本地工作区。

![ChisaCloudCode 工作区](docs/images/workspace.png)

*示例数据演示：项目、会话与路径均为虚构，不包含真实账号或服务器信息。*

## 功能

- **桌面聊天**：通过云端服务使用 Claude Code、Codex 等提供方，管理模型连接和 Claude 账号。
- **云端工作区**：按项目与会话隔离执行环境，查看文件、编辑代码、使用终端和预览。
- **SSH 本地工作区**：保留 VPS 上的 AI 服务与认证，通过 SSH 在选定的 Windows 目录执行文件、Git、构建和测试操作。
- **任务协作**：支持后台任务、消息排队、定时消息与执行状态查看。
- **项目设置**：配置项目上下文、记忆、默认参数和常用操作。

## 使用

1. 按[服务端部署说明](deploy/server/README.md)准备自己的 VPS 服务，并配置所需的模型服务或 CLI 登录。
2. 自行构建 Windows 客户端，填写自己的 **HTTPS 服务地址、用户名和密码** 登录。
3. 创建或打开云端项目；需要操作 Windows 本地文件时，按 [SSH 本地工作区指南](cloudcli-ui/docs/architecture/ssh-local-workspaces.zh-CN.md)配置连接，并显式启动所需的反向隧道。

[Releases](https://github.com/ChisaAlter/ChisaCloudCode/releases) 中的历史安装包与当前源码可能不同；客户端和服务端应从同一源码提交构建。仓库不提供公共服务器、账号或模型凭据。

当前桌面工作流以云端工作区和可选 SSH 本地工作区为准。历史文件同步、映射和 Pi 本地执行入口已停用；升级时会保留原有数据，并在可验证的情况下暂停对应的旧同步会话。详细边界见[桌面开发说明](app/README.md)与[架构说明](cloudcli-ui/docs/architecture/04-mygo-desktop-host.md)。

## 构建

需要 Windows、Node.js 24、Go 1.27.1 或更新版本，以及 [MyGo](https://github.com/egoist/mygo) 的 Windows 构建依赖。

```powershell
npm ci --prefix cloudcli-ui
npm ci --prefix app
npm run build --prefix cloudcli-ui       # Web 前端与服务端
npm run build --prefix app               # Windows 客户端与安装包
```

当前客户端构建不再需要在仓库根目录放置 Mutagen 或 SSH 可执行文件。仓库保留的 [Mutagen 源码和许可信息](ops/mutagen/README.md)及[历史运行时清单](runtime-dependencies.json)用于追溯旧版本。

服务端配置见 [`cloudcli-ui/.env.example`](cloudcli-ui/.env.example)，云端工作区说明见[工作区指南](cloudcli-ui/docs/architecture/cloud-workspaces.zh-CN.md)。真实配置、密钥、账号状态、会话、日志及构建产物应保留在仓库之外。

## 来源与许可

基于 [CloudCLI UI 1.37.3](https://github.com/siteboon/claudecodeui)，桌面壳使用 MyGo。上游信息见 [`SOURCE.json`](SOURCE.json)。

遵循 **AGPL-3.0-or-later**；上游、插件及历史同步运行时的许可与署名予以保留，见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。

## 致谢

感谢 [Linux.do](https://linux.do) 社区。
