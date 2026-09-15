# 内置 AI 助手

社区版右上角的 **AI** 按钮呼出右侧聊天栏，桌面端与工作区并排显示，不遮挡或锁定页面。用户在 **个人设置 → 开发者 → AI 设置** 配置自己的模型；入口位于个人访问令牌下方。

## 用户设置

- **OpenAI 兼容**：支持 OpenAI、DeepSeek、OpenRouter 及任意提供兼容 Chat Completions 接口的自定义网关。填写 API Base URL 和 API Key，例如 `https://api.deepseek.com/v1`，然后点击“获取模型”，按名称或 ID 搜索并选择。Base URL 留空使用 OpenAI 默认地址。
- **Anthropic**：填写 `https://api.anthropic.com`（或自己的兼容网关）和 API Key，再获取、搜索并选择模型。Base URL 留空使用 Anthropic 默认地址。
- 获取模型使用 OpenAI 的 `<base>/models` 或 Anthropic 的 `<base>/v1/models`（已有 `/v1` 时不会重复添加）；接口需要提供标准 `data` 模型列表。目录仅用于本次选择，不保存到数据库。
- 模型能力优先匹配 OpenCode 使用的 **[models.dev](https://models.dev)** 信息库，再补充服务商显式 metadata。安装包自带离线快照，已知模型无需等上游 `/models` 返回视觉、工具调用、推理或上下文信息；自定义网关中常见的原始 ID／厂商前缀也可匹配。未收录模型显示“自定义模型”，不再堆叠两条“支持情况未知”。“启用图片输入”仍保留为用户自己的开关。
- 快照来源、MIT 许可和匹配规则见 `apps/api/plane/utils/data/README.md`；可用 `python3 apps/api/scripts/refresh_models_dev.py` 更新。模型密钥不会发给 models.dev，运行时也不依赖 models.dev 网络连接。
- Key 在服务端加密保存，浏览器读取设置只能获得“是否已配置”。留空表示保留原 Key；修改提供商或 Base URL 时必须重新填写 Key。
- 设置按登录用户隔离，独立于 God Mode 的实例级 AI 写作配置。

示例需求：

> 在当前项目建一个“登录偶发白屏”的工作项，优先级高，补上复现步骤和验收标准。

> 查询这个项目的工作项，把刚才创建的单子分配给张三并加上 Bug 标签。

助手通过官方 Plane MCP 操作当前工作区，沿用当前用户的权限。支持的工具范围由社区版兼容列表限定，包括项目和成员查询、工作项创建/查询/更新、负责人、标签、评论以及基础周期/模块操作。不开放 PQL、商业版专有接口或终端执行工具。

对话只保存在当前页面内存中。收起侧栏会停止当前生成但保留会话，重新打开或在同一工作区切换项目仍可继续；“新对话”、刷新、退出登录或切换工作区才清除聊天。已完成的 Plane 修改仍然有效。配置、鉴权和连接失败会保留草稿供重试，不会误报“可能已修改”，也不强制清空对话。实际发起写操作后的中断才提示核对结果，并把上次尝试带入后续上下文。

输入框固定在底部，支持 Enter 发送、Shift+Enter 换行及中文输入法；生成时发送按钮变为停止按钮。当前模型位于输入框工具栏，消息支持复制，思考和工具步骤默认折叠，流式状态显示用时。

## 图像识别

选择支持视觉的模型并启用图像输入后，对话框可选择、拖入或粘贴 PNG、JPEG、WebP 图片，发送前可以预览和移除，也可只发图片不输入文字。每张最多 2 MiB，每个对话最多 3 张（含历史图片）。例如上传问题截图后说“根据截图创建一个 Bug”，助手会将图片传给当前用户的模型，再通过 Plane MCP 处理工作项。

图片以真正的多模态图像块发送给模型；后续追问携带此前的图片上下文。图片与聊天记录只保存在本次页面内存中，不上传到 Plane 文件存储，也不写入聊天日志；新建对话、刷新或切换工作区后移除。模型本身必须支持图像输入及所需的工具调用。

## Agent 输出渲染

对话把模型返回的思考、正文和工具信息分开显示：

| 输出内容                                                                       | 显示方式                                               |
| ------------------------------------------------------------------------------ | ------------------------------------------------------ |
| 原生 `thinking` 事件；`<think>`、`<thinking>`、`<analysis>`、`<reasoning>`     | 默认折叠的“模型思考”区，按需展开                       |
| `<tool_call>`、`<tool_calls>`、`<tool_use>`、`<function_call>`                 | 标注为“工具调用片段”，以代码显示；文字片段不会执行操作 |
| `<tool_result>`、`<tool_response>`、`<function_result>`、`<function_response>` | 标注为“工具结果片段”，与真实工具记录分开               |
| `<final>`、`<answer>`、`<response>`                                            | 去除包裹标签，直接渲染答案正文                         |
| MCP 实际执行事件                                                               | 展示执行状态、可折叠的参数/结果以及已验证的工作项链接  |

标签支持分块流式输出：未收全的已知标签不会短暂显示为正文；代码围栏、行内代码和转义后的标签保持原样。模型没有返回思考事件或标签时，不会凭空生成思考区。思考和工具详情只保留在本页内存里，下一轮只提交用户消息及答案正文。

正文支持表格、任务列表、删除线、代码高亮/复制及受限的安全 HTML（例如 `<details>`、`<kbd>`、上下标、换行）。脚本、事件属性和可执行 URL 被过滤；未知代码语言按纯文本显示。工作项编号只根据真实工具返回的引用自动生成链接。工具详情按字段白名单提取并脱敏，长结果会截断提示，原始错误响应不传到页面。

每轮工具详情随该轮回复保留，新建对话、刷新或切换工作区时一并移除。新输出只在用户停留底部时自动跟随；向上阅读后，可使用“回到最新消息”。

## 运行结构

```text
浏览器（登录会话 + CSRF）
  → Django：个人设置 / 工作区权限校验 / 流式代理
  → Live：Pi Agent（每轮独立模型与凭据）
  → 官方 Plane MCP stdio
  → Plane REST API（当前用户的短期令牌）
```

聊天和模型 Key 不进入应用日志。每轮使用独立的短期 Plane API 凭据，绑定当前工作区，结束或断开后删除。服务对运行时间、工具调用次数和并发数量设有限制，不创建定时任务或持久化 Agent 会话。

## 从源码部署

此功能同时修改 **web、api、live**，必须部署三者的自定义构建；只更新网页或继续使用旧的官方 Live 镜像不能启用助手。

1. API 应用迁移 `0133_user_ai_settings` 和 `0134_user_ai_settings_supports_images`（常规 migrator 会执行）。
2. 在 API 和 Live 环境中设置相同的随机 `LIVE_SERVER_SECRET_KEY`。
3. API 通过内部 `AI_AGENT_URL` 连接 Live：compose 默认 `http://live:3000/live`，AIO 默认 `http://127.0.0.1:3005/live`，本地开发为 `http://localhost:3100/live`。默认部署模板已配置，不再要求额外填写公开 `LIVE_BASE_URL` 才能聊天。需要自定义时可覆盖 `AI_AGENT_URL`；Live 的 `API_BASE_URL` 仍指向 Plane API 根地址，不含 `/api/v1`。
4. 构建并部署 web、api、live；AIO 会在启动时为旧 `plane.env` 补全内部地址，并包含与 AIO Python 版本匹配的 `/opt/plane-mcp` 环境。MCP 在构建阶段安装，运行时不下载。
5. 用户保存个人 AI 设置后，从工作区右上角打开 AI。

Base URL 可填写任意 HTTP(S) 模型服务地址，包括企业网关和局域网地址，无需配置域名白名单。模型发现由 API 服务访问，聊天由 Live 服务访问，因此这两个服务都需要能连接所填地址；URL 不能包含内嵌账号密码、查询参数或片段。已移除 `AI_MODEL_ALLOWED_ORIGINS` 配置。

## 本地开发

依赖 Node 22+、Python 3.10+。运行现有开发服务，并单独准备官方 MCP：

```sh
python3 -m venv .venv-mcp
.venv-mcp/bin/pip install plane-mcp-server==0.3.2
```

把 `.venv-mcp/bin/plane-mcp-server` 的**绝对路径**填写到 `apps/live/.env` 的 `PLANE_MCP_COMMAND`。API 和 Live 需要能够相互访问；若 API 在 Docker、Live 在宿主机，API 的 `AI_AGENT_URL` 必须使用容器能访问的宿主机地址及 Live 路径，不能填容器自身的 localhost。

## 排查回复中断

如果发送消息后没有正文，最后显示 `Assistant response interrupted before completion`，需要检查聊天响应是否被 gzip 压缩。项目使用的 Django 5.2 会将异步流的每一块压成独立 gzip 成员，浏览器可能只读取第一块空白心跳，丢弃后面的正文、错误事件和 `done`（[Django #36656](https://code.djangoproject.com/ticket/36656)）。

API 的压缩中间件遵守聊天响应已有的 `Cache-Control: no-store, no-transform`，使聊天流直接输出；普通响应仍可压缩。AIO 部署需要使用包含此修复的新镜像并重新创建 `plane` 容器，仅刷新网页或重启旧镜像不会加载新代码。可在浏览器网络面板检查 `/api/workspaces/<slug>/agent/chat/`：响应应为 `application/x-ndjson`，不含 `Content-Encoding: gzip`，正文应逐步出现事件并以 `done` 结束。自定义反向代理也应保留 `no-transform`、避免缓冲聊天流。

## 验证

- 压缩回归：`python3 apps/api/tests/unit/test_streaming_gzip.py`（只需安装 API 使用的 Django，无需数据库或模型服务）。
- Web：`node --test apps/web/helpers/agent-*.test.mjs`
- UI 渲染器：`pnpm --filter @plane/ui test:chat-markdown`
- 浏览器：`pnpm --filter web test:browser ai-assistant.spec.ts settings-navigation.spec.ts --workers=1`
- Live：`pnpm --filter live exec vitest run tests/services/ai tests/controllers/ai.controller.test.ts`
- Python：新增 AI 单元测试和契约测试位于 `apps/api/plane/tests`，使用仓库的 Docker pytest 测试栈执行。
- 完整类型检查需先运行 `pnpm turbo run build --filter='web^...' --filter='live^...'`。

真实模型的可用性、工具调用质量以及余额需用用户配置的服务验证。单元测试使用模拟响应，不消耗模型额度。
