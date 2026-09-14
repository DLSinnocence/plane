# 内置 AI 助手

社区版的右上角 **AI** 按钮打开即时对话框。用户在 **个人设置 → 开发者 → AI 设置** 配置自己的模型；入口位于个人访问令牌下方。

## 用户设置

- **OpenAI 兼容**：支持 OpenAI、DeepSeek、OpenRouter 及任意提供兼容 Chat Completions 接口的自定义网关。填写 API Base URL 和 API Key，例如 `https://api.deepseek.com/v1`，然后点击“获取模型”，按名称或 ID 搜索并选择。Base URL 留空使用 OpenAI 默认地址。
- **Anthropic**：填写 `https://api.anthropic.com`（或自己的兼容网关）和 API Key，再获取、搜索并选择模型。Base URL 留空使用 Anthropic 默认地址。
- 获取模型使用 OpenAI 的 `<base>/models` 或 Anthropic 的 `<base>/v1/models`（已有 `/v1` 时不会重复添加）；接口需要提供标准 `data` 模型列表。目录仅用于本次选择，不保存到数据库。
- 模型列表展示上游明确提供的图像输入和工具调用能力；未提供能力信息时标为未知，可自行开启“启用图像输入”。不要仅根据模型名字推断能力。
- Key 在服务端加密保存，浏览器读取设置只能获得“是否已配置”。留空表示保留原 Key；修改提供商或 Base URL 时必须重新填写 Key。
- 设置按登录用户隔离，独立于 God Mode 的实例级 AI 写作配置。

示例需求：

> 在当前项目建一个“登录偶发白屏”的工作项，优先级高，补上复现步骤和验收标准。

> 查询这个项目的工作项，把刚才创建的单子分配给张三并加上 Bug 标签。

助手通过官方 Plane MCP 操作当前工作区，沿用当前用户的权限。支持的工具范围由社区版兼容列表限定，包括项目和成员查询、工作项创建/查询/更新、负责人、标签、评论以及基础周期/模块操作。不开放 PQL、商业版专有接口或终端执行工具。

对话只保存在当前页面的内存里。关闭、刷新或切换上下文会清除聊天并停止当前请求；已经完成的 Plane 修改仍然有效。遇到中断，应先检查操作结果，避免重复建单。正常的工作项活动记录和 API 审计仍按 Plane 的现有规则保留。

## 图像识别

选择支持视觉的模型并启用图像输入后，对话框可选择、拖入或粘贴 PNG、JPEG、WebP 图片，发送前可以预览和移除，也可只发图片不输入文字。每张最多 2 MiB，每个对话最多 3 张（含历史图片）。例如上传问题截图后说“根据截图创建一个 Bug”，助手会将图片传给当前用户的模型，再通过 Plane MCP 处理工作项。

图片以真正的多模态图像块发送给模型；后续追问携带此前的图片上下文。图片与聊天记录只保存在本次页面内存中，不上传到 Plane 文件存储，也不写入聊天日志；清空、关闭或切换上下文后移除。模型本身必须支持图像输入及所需的工具调用。

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

每轮的工具详情随该轮回复保留，关闭/刷新/清空时一并移除。新输出只在用户停留底部时自动跟随；向上阅读后，可使用“回到最新消息”。

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
3. API 的 `LIVE_BASE_URL` 和 `LIVE_BASE_PATH` 指向可从 API 容器访问的 Live 服务。Live 的 `API_BASE_URL` 指向 Plane API 根地址，不包含 `/api/v1`。
4. 构建并部署 web、api、live；仓库根 `docker-compose.yml` 已接上容器内部地址。Live 镜像在构建阶段安装 `plane-mcp-server==0.3.2`，运行时不下载程序。
5. 用户保存个人 AI 设置后，从工作区右上角打开 AI。

Base URL 可填写任意 HTTP(S) 模型服务地址，包括企业网关和局域网地址，无需配置域名白名单。模型发现由 API 服务访问，聊天由 Live 服务访问，因此这两个服务都需要能连接所填地址；URL 不能包含内嵌账号密码、查询参数或片段。已移除 `AI_MODEL_ALLOWED_ORIGINS` 配置。

## 本地开发

依赖 Node 22+、Python 3.10+。运行现有开发服务，并单独准备官方 MCP：

```sh
python3 -m venv .venv-mcp
.venv-mcp/bin/pip install plane-mcp-server==0.3.2
```

把 `.venv-mcp/bin/plane-mcp-server` 的**绝对路径**填写到 `apps/live/.env` 的 `PLANE_MCP_COMMAND`。API 和 Live 需要能够相互访问；若 API 在 Docker、Live 在宿主机，API 的 `LIVE_BASE_URL` 必须使用容器能访问的宿主机地址，不能填容器自身的 localhost。

## 验证

- Web：`node --test apps/web/helpers/agent-*.test.mjs`
- UI 渲染器：`pnpm --filter @plane/ui test:chat-markdown`
- 浏览器：`pnpm --filter web test:browser ai-assistant.spec.ts settings-navigation.spec.ts --workers=1`
- Live：`pnpm --filter live exec vitest run tests/services/ai tests/controllers/ai.controller.test.ts`
- Python：新增 AI 单元测试和契约测试位于 `apps/api/plane/tests`，使用仓库的 Docker pytest 测试栈执行。
- 完整类型检查需先运行 `pnpm turbo run build --filter='web^...' --filter='live^...'`。

真实模型的可用性、工具调用质量以及余额需用用户配置的服务验证。单元测试使用模拟响应，不消耗模型额度。
