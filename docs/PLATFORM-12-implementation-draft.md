# PLATFORM-12 实施记录：工作区 AI 设置

需求：[PLATFORM-12](https://task.meowalive.com/meowalive/projects/28157354-6d61-4ea5-9e27-03c6f53df206/issues/471e35c6-ba5d-4205-b527-4ae9d74329c6)

## 行为与权限

工作区设置新增 `/<workspaceSlug>/settings/ai/`。管理员可维护多个供应商，每个供应商可维护多个模型，并指定一个工作区默认模型。成员和访客可查看公开配置，修改和模型发现接口仅允许管理员访问。

供应商支持 OpenAI 兼容协议和 Anthropic、自定义名称、Base URL、加密 API Key 和启用状态。模型支持名称、图片能力、启用状态和默认标记。同一供应商下模型名称唯一，一个工作区最多一个默认模型。停用或删除默认模型及其供应商后，需要管理员重新指定默认模型。

助手面板和聊天接口都读取当前工作区启用的默认模型。成员无需填写个人密钥；无默认模型时显示配置提示。AI 工具调用仍使用发起请求成员的临时工作区令牌，不获得管理员身份或额外项目权限。

## 主要实现

- `apps/api/plane/db/models/ai.py`：WorkspaceAIProvider、WorkspaceAIModel；模型包含 workspace 外键，用于数据库层的默认模型唯一约束。
- `apps/api/plane/db/migrations/0135_workspace_ai_settings.py`：新增表和约束。
- `apps/api/plane/app/views/ai.py`、`serializers/ai.py`：工作区配置 CRUD、模型发现、默认模型切换及聊天配置解析。
- `apps/api/plane/middleware/logger.py`：工作区 AI 配置请求不写入 API 请求/响应日志，避免保存凭据。
- `apps/web/core/components/workspace/settings/ai/`：供应商及模型管理页面。
- `apps/web/core/services/workspace-ai.service.ts`：工作区 API 客户端，复用 CSRF 请求实现。
- `apps/web/core/components/navigation/ai-assistant.tsx`：读取工作区默认模型及图片能力，配置入口指向工作区设置。
- 工作区路由、侧栏常量、图标和类型同步添加 AI 设置入口。

## API

以下路径均以 `/api/workspaces/<slug>/ai-settings/` 开头：

| 方法           | 子路径                                       | 权限及用途               |
| -------------- | -------------------------------------------- | ------------------------ |
| GET            | 根路径                                       | 活跃成员读取供应商和模型 |
| POST           | `providers/`                                 | 管理员创建供应商         |
| PATCH / DELETE | `providers/<provider_id>/`                   | 管理员修改或删除供应商   |
| POST           | `providers/<provider_id>/models/`            | 管理员创建模型           |
| PATCH / DELETE | `providers/<provider_id>/models/<model_id>/` | 管理员修改或删除模型     |
| POST           | `models/`                                    | 管理员发现供应商模型     |

GET 返回 `{providers:[...]}`；供应商只返回 `has_api_key`，不返回明文或密文。修改接口只接受允许的字段，所有对象 ID 都按工作区限定。写入使用会话认证和 CSRF 校验。

模型默认状态变更在工作区行锁内完成，读取对象也在锁内执行，避免并发停用或删除后的旧对象状态被写回；数据库唯一约束作为第二层保护。修改供应商协议或 Base URL 必须同时提交新密钥，空密钥只在目标不变时表示保留旧值。

模型发现可使用当前工作区指定供应商的已保存密钥，但必须匹配协议和规范化 Base URL。临时提交的密钥只用于本次发现请求，不自动保存。

## 升级与原草案的调整

迁移只创建数据库结构，**不自动复制个人密钥**。原草案按 owner/管理员选择个人凭据的方案会扩大个人凭据的使用范围，实际实现改为管理员显式配置工作区共享供应商。

升级后需正常执行 Django migrations，然后由管理员添加供应商、添加模型并设置默认模型。现有 `UserAISettings` 数据和个人 API 暂时保留兼容；工作区聊天不会回退读取个人配置。原草案中可选的根路径 PATCH 接口未实现，因为没有需要独立保存的工作区通用字段。

## 验证

新增后端契约测试位于 `apps/api/plane/tests/contract/app/test_workspace_ai_settings.py`，现有聊天契约、流式单元测试和 live 集成测试同步改用工作区配置。新增前端请求测试位于 `apps/web/core/services/workspace-ai.service.test.mjs`。

已经执行并通过：

- Web 依赖包构建。
- 前端请求测试共 9 项（含旧个人 API 兼容测试）。
- 后端 Python 编译检查。

前端设置交互补充修复后需再执行最终类型检查、格式检查及浏览器测试，结果在交付时记录。

当前环境没有 Docker，系统 Python 缺少 Django/pytest，尚未运行真实数据库迁移和后端测试。后端完整验证需在仓库隔离测试栈中执行，不能以 Python 编译检查替代：

```bash
docker compose -f docker-compose-test.yml run --rm api-tests pytest plane/tests/contract/app/test_workspace_ai_settings.py plane/tests/contract/app/test_ai_app.py plane/tests/unit/test_ai_stream.py
```
