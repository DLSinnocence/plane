# PLATFORM-5 实现草案：Plane AI 提示词与写作 Skill

关联需求：[PLATFORM-5](https://work.meowalive.com/?plane_project=28157354-6d61-4ea5-9e27-03c6f53df206&plane_item=d07de605-87b2-4faa-8715-4e1d4b5264e3)

状态：已按本草案完成代码实现。下文保留实现前的分析和方案；使用方式见 `docs/embedded-ai.md`。

已验证：Live AI 的 141 项测试、Web AI helper 的 33 项测试、Live/Web 类型检查、Live 生产构建、20 个语言包的键同步，以及修改代码的 lint 与格式检查。新增 HTTP 测试使用本地模拟服务，覆盖 OpenAI 和 Anthropic 的 Skill 调用及正文回传。

验证限制：当前环境未配置真实模型凭据，尚未验证真实模型的写作质量，也未部署这些改动。

## 目标与范围

优化 Plane 右侧内置 AI 助手的提示词，并提供可调用的工作项写作 Skill。创建、改写或精简描述时，默认简明表达用户需求和期望行为，不自动追加验收标准、实现方案等章节；用户明确要求的内容优先。

本次改动集中在 Live Agent、已有工具记录展示和使用文档。不需要数据库迁移或新增设置页面；God Mode 的实例级 AI 写作功能不在本次默认范围内。

## 当前实现依据

- `apps/live/src/services/ai/runtime.ts`：`runAiChat` 内联构造系统提示词，注册的工具全部来自 `createCeTools`，没有内置 Skill 目录或加载工具。
- `apps/live/src/services/ai/tools.ts`：`CE_ACTIONS` 是官方 MCP 的社区版操作白名单，`createCeTools` 处理参数验证、工具调用计数、结果投影和写操作标记。
- `runtime.ts` 的工具事件只接受 `CE_ACTIONS` 中的名称和操作。新增本地 Skill 工具需要单独接入事件，不能只注册到 Agent。
- `apps/web/helpers/agent-chat.ts`：工具展示名称只认识 Plane 实体，未知工具会显示为工作空间，需要补充 Skill 的名称和加载动作。
- `apps/web/helpers/agent-stream.ts` 已支持字符串工具名称、操作和安全详情；Django 的 `stream_agent_turn` 透传 Live 数据，预计无需调整流式协议或 API。
- `apps/live/tsdown.config.ts` 从 `src/start.ts` 打包。仓库内 `.claude/skills` 是开发工具使用的文档，当前运行时没有读取它们的逻辑。

## 建议实现

### 1. 提示词独立管理

新增 `apps/live/src/services/ai/prompts.ts`，由纯函数构造系统提示词，参数仅包含工作区、项目上下文及内置 Skill 的名称和用途。

提示词明确以下行为：

- 按用户使用的语言回答，简短说明实际完成的操作。
- 区分撰写草稿与修改 Plane 数据；用户要求草稿时返回正文，要求创建或更新时执行对应工具。
- 在撰写、改写或精简工作项标题与描述前，加载 `writing-plane-requirements`；只修改负责人、状态等字段时无需加载。
- 用户明确点名该 Skill 时可以直接调用；每次请求都重新提供 Skill 目录，因为现有历史只保留用户消息和助手正文。
- 保留现有的资源 ID 核对、分页、社区版能力范围、写入失败后核实状态以及凭据保护规则。
- 明确内置 Skill 是服务端提供的写作指导；用户内容、Plane 数据和 MCP 返回文本仍是任务数据。Skill 不改变工具权限和用户授权范围。

写作细则只在 Skill 定义中维护，系统提示词保留触发条件与调用方式。

### 2. 内置写作 Skill 与只读加载工具

建议新增：

- `apps/live/src/services/ai/skills/writing-plane-requirements.ts`：维护 Skill 的名称、用途和正文。
- `apps/live/src/services/ai/skills.ts`：维护固定注册表，导出目录信息和只读 Agent 工具。

首版将 Skill 作为 TypeScript 静态资源打包，避免依赖运行容器中的额外 Markdown 文件。只需支持内置注册项，无需引入通用目录扫描、上传或插件管理。

调用形式建议为：

```json
{ "action": "load", "name": "writing-plane-requirements" }
```

工具名称为 `skill`。参数采用严格 schema，并在执行入口验证名称；返回指定 Skill 正文，未知名称返回简短错误。加载操作不调用 MCP、不修改工作项，沿用运行时的取消信号和工具调用次数限制。

写作 Skill 的正文草案：

> 编写或修改工作项标题与描述时，沿用用户指定的标题、前缀和范围。用一小段话说明需求，必要时补充少量期望行为；简单需求用一两句话即可。
>
> 保留理解需求必需的背景、约束和已有事实，每个要点表达一个意思。信息不足时，只询问影响理解或执行的关键问题。
>
> 默认正文只包含需求与期望结果，不自动添加验收标准、实现方案、测试计划或开发记录。用户明确要求某类内容时按其要求补充，已有的重要约束在精简后仍应保留。
>
> 返回或写入前，删除重复内容和未经用户要求扩展的功能，确认标题与正文表达同一目标。

此定义由 Plane 内置助手注册和调用；当前 DSH 会话中提供的同名 Skill 不会自动进入 Plane Agent。

### 3. 接入运行时与工具展示

在 `runtime.ts` 中组合 MCP 工具和本地 Skill 工具，同时保留现有 MCP 兼容性检查，避免一个本地工具掩盖 Plane 工具初始化失败。

将调用计数和取消检查提取为两类工具可共用的请求内回调。仅 MCP 写操作触发 `mayHaveChanges`；Skill 加载成功或失败均不标记数据可能已修改。

工具事件继续使用现有 `tool` 帧，为 `skill/load` 增加明确的本地校验分支。`CE_ACTIONS` 保持官方 MCP 操作白名单职责，不把本地工具交给 MCP。

Skill 工具通过服务端回调登记可展示详情，沿用现有验证结果来源的方式，不直接信任模型事件携带的详情。界面显示 Skill 名称和加载结果即可，不需要把完整写作正文或内部信息发给浏览器。

在 `apps/web/helpers/agent-chat.ts` 补充工具名称和动作映射，在 `packages/i18n/src/locales/*/settings.json` 按现有语言资源约定补齐对应键，展示类似“加载写作规范”的记录。

### 4. 更新使用说明

更新 `docs/embedded-ai.md`，说明默认简洁写作行为、自动触发场景和点名调用方式。将现有示例中主动要求验收标准的请求标注为显式指定格式的例子，另补一个默认简洁描述示例。

## 验证方案

自动化验证关注可执行行为，不以整段提示词快照或模拟答案证明真实写作质量。

- 新增 Skill 单元测试：合法名称返回正文、未知名称及非法参数被拒绝、取消后不执行、加载过程不访问 MCP。
- 补充 Live 运行时测试：Agent 实际注册 Skill 工具；加载产生完整工具事件；共享调用额度生效；只有 Skill 加载的失败不会令 `may_have_changes` 变为真。
- 使用现有本地模拟模型方式覆盖“模型请求加载 Skill → 收到正文 → 继续回复或调用工作项工具”的完整链路，确认工具返回确实进入下一轮模型上下文。
- 补充 Web helper 测试，覆盖加载标签、状态更新和流解析；运行已有 AI 测试集保护 MCP 写入、错误处理和流式输出。

实现后的检查命令：

```sh
pnpm --filter live exec vitest run tests/services/ai tests/controllers/ai.controller.test.ts
node --test apps/web/helpers/agent-*.test.mjs
pnpm --filter live check:types
pnpm --filter web check:types
pnpm --filter live build
```

同时执行受影响文件的格式和 lint 检查。类型检查前按 `docs/embedded-ai.md` 的说明准备依赖包构建产物。

真实模型验证使用已配置的服务，至少覆盖：默认创建简短需求、精简已有长描述、明确要求验收标准、点名调用 Skill、只修改状态。检查真实工具记录、提交给 Plane 的描述以及最终保存结果。默认写作应触发 Skill；显式格式要求应保留；仅修改状态无需调用写作 Skill。

自动化测试可以证明 Skill 可调用和链路正确；是否稳定产出简明文本仍需真实模型验证。

## 实施顺序

1. 添加 Skill 定义、只读工具和提示词构造函数，完成对应单元验证。
2. 接入运行时、调用额度和工具事件，验证完整调用链及失败行为。
3. 补齐前端展示、语言资源和使用说明，完成相关回归与构建。
4. 在测试项目通过真实模型验证写作结果，记录模型与观察到的行为。
