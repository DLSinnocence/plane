# 内置 AI 助手

社区版的右上角 **AI** 按钮打开即时对话框。用户在 **个人设置 → 开发者 → AI 设置** 配置自己的模型；入口位于个人访问令牌下方。

## 用户设置

- **OpenAI 兼容**：支持 OpenAI、DeepSeek、OpenRouter 等提供兼容 Chat Completions 接口的服务。填写其 API Base URL、支持工具调用的模型 ID 和 API Key。例如 DeepSeek 可使用 `https://api.deepseek.com/v1`。
- **Anthropic**：填写 `https://api.anthropic.com`、当前可用的 Claude 模型 ID 和自己的 API Key。
- Key 在服务端加密保存，浏览器读取设置只能获得“是否已配置”。留空表示保留原 Key；修改提供商或 Base URL 时必须重新填写 Key。
- 设置按登录用户隔离，独立于 God Mode 的实例级 AI 写作配置。

示例需求：

> 在当前项目建一个“登录偶发白屏”的工作项，优先级高，补上复现步骤和验收标准。

> 查询这个项目的工作项，把刚才创建的单子分配给张三并加上 Bug 标签。

助手通过官方 Plane MCP 操作当前工作区，沿用当前用户的权限。支持的工具范围由社区版兼容列表限定，包括项目和成员查询、工作项创建/查询/更新、负责人、标签、评论以及基础周期/模块操作。不开放 PQL、商业版专有接口或终端执行工具。

对话只保存在当前页面的内存里。关闭、刷新或切换上下文会清除聊天并停止当前请求；已经完成的 Plane 修改仍然有效。遇到中断，应先检查操作结果，避免重复建单。正常的工作项活动记录和 API 审计仍按 Plane 的现有规则保留。

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

1. API 应用迁移 `0133_user_ai_settings`（常规 migrator 会执行）。
2. 在 API 和 Live 环境中设置相同的随机 `LIVE_SERVER_SECRET_KEY`。
3. API 的 `LIVE_BASE_URL` 和 `LIVE_BASE_PATH` 指向可从 API 容器访问的 Live 服务。Live 的 `API_BASE_URL` 指向 Plane API 根地址，不包含 `/api/v1`。
4. 构建并部署 web、api、live；仓库根 `docker-compose.yml` 已接上容器内部地址。Live 镜像在构建阶段安装 `plane-mcp-server==0.3.2`，运行时不下载程序。
5. 用户保存个人 AI 设置后，从工作区右上角打开 AI。

默认允许 OpenAI、Anthropic、DeepSeek、OpenRouter 和 SiliconFlow 的官方 API origin。使用企业网关或私有模型时，由管理员把完整可信 origin（协议、主机及非默认端口，不带路径）添加到 API 的 `AI_MODEL_ALLOWED_ORIGINS`，然后重启 API。该变量是完整列表，配置时保留仍需使用的其它 origin。

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
