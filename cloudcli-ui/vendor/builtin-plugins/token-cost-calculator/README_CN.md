# Token Cost Calculator（Token 费用计算器）

**在收到账单之前，先搞清楚你到底花了多少钱。**

你正在用 Claude Code 埋头写代码，连续肝了几个小时，突然心里一紧：*"今天我到底花了多少 API 费用？"* 不用登录 Anthropic / OpenAI / DeepSeek 的账单后台翻来翻去，打开这个插件，一眼就看到了：**今天 ￥17.12，本月 ￥133.85，从安装到现在一共 ￥1,042.90。**

Token Cost Calculator 是一个 CloudCLI 标签页插件，直接读取 Claude Code 存在本地的会话 JSONL 转录文件（路径：`~/.claude/projects/`），把原始 token 数量换算成真金白银。主对话、子代理会话、prompt 缓存命中、推理模型的思考 token —— 全都覆盖。还支持按天、按项目、全历史三种维度查看明细，全程不需要手动输入任何东西。

<img width="1468" height="909" alt="image" src="https://github.com/user-attachments/assets/aa33e4b6-d2cf-4f7d-b1d6-a7e476979596" />

---

## 这个插件到底能干啥（说人话版）

- **自动读取真实用量。** 不用去账单页复制粘贴。插件自动扫描 Claude Code 存在你硬盘上的 JSONL 会话文件，提取 `input_tokens`、`output_tokens`、`cache_read_input_tokens`、`cache_creation_input_tokens`，乘以你设的价格，算出花了多少钱。
- **五种角度看数据。** Manual（手动模式）适合快速估算；Auto-detect（自动检测）看当前会话；Project（项目模式）回答"这个仓库总共花了多少"；All-time（全局模式）看从安装到现在的总账；Daily（每日模式）带日期选择器，默认显示今天，可以翻到"上周二花了多少"。
- **内置模型价格表。** Claude Opus 4.7、Sonnet 4.6、Haiku 4.5、GPT-4o、GPT-4o-mini、Gemini 2.5 Pro/Flash、DeepSeek V4 Pro —— 下拉菜单直接选，也支持自己填每百万 token 的自定义价格。
- **处理坑爹的边界情况。** DeepSeek 这类推理模型，一个 API 调用会产出一串内容块（思考 → 正文 → 工具调用），每个块在 JSONL 里单独占一行，但 `message.usage` 是完全相同的。插件靠 `message.id` 去重，不会把同一轮对话的 token 数翻 3 倍。子代理会话（Claude Code 的 Task 工具调用的）也会一并统计。

---

## 三步安装，零配置

### 第一步 —— 克隆到插件目录

```bash
cd ~/.claude-code-ui/plugins
git clone https://github.com/NightmareAway/cloudcli-plugin-token-cost-calculator.git token-cost-calculator
```

### 第二步 —— 安装依赖并编译

```bash
cd token-cost-calculator
npm install
npm run build
```

### 第三步 —— 重启 CloudCLI

关掉再打开 CloudCLI（或者重载插件面板），**Token Cost Calculator** 标签页就出现了。

没有 API Key，没有 `.env` 配置文件，什么都不用填。插件读的就是 Claude Code 本来就在你电脑上存着的东西。

---

## 五种模式一览

| 模式 | 适合场景 | 你能看到什么 |
|---|---|---|
| **Manual**（手动） | 快速估算、假设"如果我用 XX 模型" | 自己填 token 数，有 +1K / +10K / +100K / +1M / +10M 快捷按钮 |
| **Auto-detect**（自动检测） | 正在进行的会话 | 实时读取当前 JSONL 转录文件，含所有轮次和子代理 |
| **Project**（项目） | "这个仓库总共烧了多少钱？" | 该项目文件夹下所有会话汇总，逐条列出 session ID 和模型 |
| **All-time**（全局） | "从装 Claude Code 到现在一共花了多少？" | 所有项目汇总，彩色进度条，一个项目一根条 |
| **Daily**（每日） | "今天就花了多少？" 或 "上周三呢？" | 日期导航器（◀ ▶ 按钮），默认当天，点列表中任意日期即可切换 |

所有模式共用同一套价格面板和底部的费用明细。切模式不会丢价格设置。

---

## 涉及的技术关键词（方便搜索到这儿）

插件内部干了很多脏活累活，下面这些词可能刚好是你搜索时用到的：

- **Claude Code 插件 / CloudCLI 插件** — 基于 CloudCLI 插件架构开发（`manifest.json` + `mount`/`unmount` 生命周期）。后端是 Node.js HTTP 子进程。
- **大模型 token 费用计算 / API 花费追踪** — 用 `input_tokens` / `output_tokens` / `cache_read_input_tokens` 乘以每百万 token 单价。支持 Anthropic Claude、OpenAI GPT、Google Gemini、DeepSeek 的定价。
- **Prompt 缓存计费** — 单独统计 `cache_creation_input_tokens` 和 `cache_read_input_tokens`，按较低的缓存价格算。长对话里缓存往往是隐藏的费用大头。
- **JSONL 会话转录解析** — 用 Node.js `readline` 逐行读取 `~/.claude/projects/<编码后的路径>/<session-uuid>.jsonl`，筛选 `"type": "assistant"` 的条目，提取 `message.usage`。
- **Message ID 去重** — 推理模型（DeepSeek V4 Pro 等）一个 API 调用产生多行 assistant 记录（thinking + text + tool_use），每行的 `usage` 一模一样。插件用 `Set<string>` 记录 `message.id`，跳过重复行，避免翻倍计算。
- **子代理 / 工具调用会话** — Claude Code 的 Task 工具会启动子代理，转录文件存在 `<session-dir>/subagents/*.jsonl`。插件递归扫描并计入总数。
- **Windows 路径编码** — Claude Code 把 `C:\Users\...` 编码为 `C--Users-...`（`\` `:` 空格 `_` 全替换成 `-`）。插件做了路径标准化和反向映射。
- **按天汇总 Token** — 用 JSONL 中的 `timestamp` 字段（ISO 8601 格式）提取 `YYYY-MM-DD`，按天归并。前端日期导航器支持前后翻页和一键回今天。
- **localStorage 状态持久化** — 当前模式、自定义价格、手动输入的 token 数，刷新页面不会丢。

---

## 项目结构

```
token-cost-calculator/
├── manifest.json        # CloudCLI 插件元数据（slot: tab）
├── package.json
├── tsconfig.json
├── icon.svg
└── src/
    ├── index.ts         # 前端：5 种模式 UI、日期导航器、深色/浅色主题
    ├── server.ts        # 后端：HTTP API、JSONL 读取、token 汇总
    └── types.ts         # PluginContext / PluginAPI / PluginModule 类型定义
```

## 后端 API 接口

| 接口 | 返回内容 |
|---|---|
| `GET /presets` | 8 个内置模型的价格 |
| `GET /session-usage?projectPath=...&sessionId=...` | 单个会话的 token 数 + 模型名 |
| `POST /calculate` | 给定 token 和价格后的费用明细 |
| `GET /project-usage?projectPath=...` | 某项目下所有会话汇总 |
| `GET /all-usage` | 所有项目，按 token 总量降序排列 |
| `GET /daily-usage` | 所有会话按 `YYYY-MM-DD` 分组 |

## 开发

```bash
npm install
npm run dev     # tsc --watch
npm run build   # tsc
```

MIT.
