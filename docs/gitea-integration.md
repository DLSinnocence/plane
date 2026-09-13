# Gitea 工作项单号校验与提交链接关联

集成按工作空间鉴权，工作项由完整单号定位。项目与代码仓库没有绑定关系：同一代码仓库可以引用工作空间内多个项目的单号，同一工作项也可以关联多个仓库中的提交。关联使用调用方上报的完整提交 URL。

## 接入流程

1. 在 **工作空间设置 → 集成 → Gitea** 中启用集成，系统生成一个工作空间级密钥。
2. 填写代码仓库的浏览地址（如 `https://git.example/team/shared-code`），生成 `pre-receive` 和 `post-receive` 两份钩子。该地址只用来生成提交链接，不保存为仓库配置，也不绑定项目。
3. 在 Gitea 仓库的 **设置 → Git 钩子** 中安装到各自对应的钩子。Gitea 运行环境需要 **Python 3 + Git**，不需要额外 Python 包、curl、jq 或 Gitea PAT。
4. 开发者推送时，pre-receive 读取所有新提交并调用校验 API；推送成功后，post-receive 上报提交说明与提交 URL，API 据单号建立关联。

也可以直接调用下面的 API，无需使用生成的钩子。上报端只要提供提交 URL，即可来自不同仓库；不需要先登记仓库，也不需要 `repository_id`。

例如同一次推送可以包含：

```text
SHOP-123 fix: 修复订单保存
OPS-45 chore: 更新部署配置
```

API 根据 `SHOP`、`OPS` 定位当前工作空间中的对应项目，再按工作项序号查真实记录。首行格式为完整单号、空格或 Tab、非空提交说明。草稿和已删除工作项不接受；已完成、已取消工作项仍可关联。

## 密钥

所有外部校验、上报和查询接口使用同一个工作空间集成密钥：

```http
Authorization: Bearer <workspace-integration-secret>
```

密钥自动生成、加密保存，管理员主动生成钩子时才嵌入返回的脚本。它具有该工作空间的单号查询及提交关联写入权限，不是 Gitea 访问令牌。

旋转密钥后，需要重新生成并替换该工作空间已安装的两份钩子。停用后，旧 pre-receive 会校验失败并拒绝 push；停用前应安排移除或替换钩子。

## 校验 API

```http
POST /api/integrations/gitea/{workspace_slug}/validate/
Authorization: Bearer <workspace-integration-secret>
Content-Type: application/json
```

```json
{
  "commits": [
    {
      "sha": "0123456789012345678901234567890123456789",
      "message": "SHOP-123 fix: 修复订单保存"
    },
    {
      "sha": "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
      "message": "OPS-45 chore: 更新部署配置"
    }
  ]
}
```

成功完成校验后返回 HTTP 200；调用者必须检查整体及每条结果的 `valid`，不能仅凭 HTTP 200 放行：

```json
{
  "valid": true,
  "results": [
    {
      "sha": "0123456789012345678901234567890123456789",
      "valid": true,
      "identifier": "SHOP-123",
      "work_item": {
        "id": "<issue UUID>",
        "project_id": "<project UUID>",
        "identifier": "SHOP-123",
        "name": "修复订单保存",
        "url": "https://plane.example/team/browse/SHOP-123/"
      },
      "error": null
    }
  ]
}
```

示例响应省略了第二条结果。实际响应逐一对应请求中的所有提交。

不合规时 `valid` 为 false，并提供各条结果的 `error.code`、`error.message`。错误密钥、停用、超时、无效响应都会让生成的 pre-receive 拒绝整个 push。该接口只校验，不保存提交关联，不访问任何代码仓库。

## 成功推送后上报提交链接

```http
POST /api/integrations/gitea/{workspace_slug}/commits/
Authorization: Bearer <workspace-integration-secret>
Content-Type: application/json
```

```json
{
  "commits": [
    {
      "sha": "0123456789012345678901234567890123456789",
      "message": "SHOP-123 fix: 修复订单保存",
      "url": "https://git.example/team/order-service/commit/0123456789012345678901234567890123456789",
      "author_name": "张三",
      "committed_at": "2026-01-10T08:30:00Z",
      "repository_name": "team/order-service",
      "branch": "main"
    }
  ]
}
```

其中 `sha`、`message`、`url` 必填，作者、时间、仓库显示名称和分支为可选元数据。`repository_name` 只是展示文字，不参与项目定位或授权。

处理方式：

- 按工作项单号定位当前工作空间的项目和工作项；不要求该项目与 URL 中的代码仓库对应。
- 保存调用方传入的 URL，工作项页面直接使用它跳转，不根据预登记的仓库拼接地址。
- 同一工作项可多次收到来自不同代码仓库的提交链接。
- URL 必须为无内嵌凭据的绝对 HTTP(S) 地址，拒绝脚本协议和控制字符。API 不下载或请求此 URL。
- 同一工作空间内相同 URL 的相同提交重复上报保持幂等，不新增重复记录；同一 URL 若上报不同 SHA 或提交说明则拒绝冲突。
- 整批先完成单号和字段校验，再原子保存。存在无效条目时返回错误，该批不部分落库。

成功响应包含 `valid: true`、逐提交 `results`（含工作项及反向 URL）和 `linked_count`。

此接口信任持有工作空间密钥的调用方仅上报已成功推送的提交。它无法仅通过提交 URL 证明远端 push 已发生，也不会调用 Gitea REST 验证。生成的 post-receive 由 Git 在成功推送后触发，负责保证正常接入流程中的调用顺序。

## 双向查询和跳转

Git 调用方查询工作项：

```http
GET /api/integrations/gitea/{workspace_slug}/work-items/SHOP-123/
Authorization: Bearer <workspace-integration-secret>
```

返回工作项的 `id`、`project_id`、`identifier`、`name`、`url`。查询范围仅为密钥对应的工作空间，不限制到某一个项目。

根据提交查关联工作项：

```http
GET /api/integrations/gitea/{workspace_slug}/commits/{sha}/work-items/
Authorization: Bearer <workspace-integration-secret>
```

可选 query 参数 `url` 用于区分相同 SHA 在不同仓库中的记录，返回 `{ "results": [<work_item>] }`。

工作项页面查询提交（使用 Plane 登录会话及项目访问权限）：

```http
GET /api/workspaces/{workspace_slug}/projects/{project_id}/issues/{issue_id}/git-commits/?page=1
```

返回 `results`、`count`、`next_page`，每页 25 条。在工作项右上角 **⋯ → 关联提交** 打开独立列表弹窗，查看提交 SHA、说明、作者、时间、仓库显示名，并点击打开已上报的 URL。完整详情和快速预览共用这个菜单入口；详情正文不展示提交列表，也不会预先请求该接口。关闭弹窗返回工作项，再次打开从第一页查看；切换到其他工作项会关闭原弹窗。

成功的 post-receive 会在 Git 推送终端打印 API 返回的工作项地址。其它 Git 接入端也可用查询/上报响应中的 `work_item.url` 建立回跳入口。集成本身不配置 Gitea PAT、不主动向 Gitea 写提交状态，也不自动把 Gitea 网页中的裸单号变成链接。

## 管理 API

以下接口仅允许当前工作空间的有效管理员通过登录会话访问：

| 方法和路径                                                     | 用途                                                                      |
| -------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `GET /api/workspaces/{slug}/integrations/gitea/`               | 获取启用状态、密钥是否已配置及 API 地址                                   |
| `PATCH /api/workspaces/{slug}/integrations/gitea/`             | 以 `{ "enabled": true }` 启用，首次自动生成密钥；false 停用               |
| `POST /api/workspaces/{slug}/integrations/gitea/rotate-token/` | 旋转工作空间集成密钥                                                      |
| `POST /api/workspaces/{slug}/integrations/gitea/hooks/`        | 根据 `{ "repository_url": "https://git.example/team/repo" }` 生成两份钩子 |

配置响应为 `enabled`、`has_secret`、`validation_url`、`commits_url`、`lookup_url` 和 `issue_url_template`，不包含仓库 ID、项目绑定或密钥明文。hooks 响应包含 `pre_receive`、`post_receive` 两个对象，各有 `filename`、`content`，禁止缓存。仓库 URL 只在该生成请求内使用，输入不同 URL 可为不同仓库生成脚本，工作空间配置保持不变。

## 钩子运行和故障处理

- Plane 的 `APP_BASE_URL` 或 `WEB_URL` 应为 Git 服务器实际可访问的地址。Git 服务器调用 Plane，Plane 不需要访问 Git 服务器。
- Gitea 需允许自定义 Git Hooks；使用 Gitea 的 **设置 → Git 钩子** 编辑器分别安装两份脚本。实例默认关闭时，管理员需设置 `[security] DISABLE_GIT_HOOKS = false` 并按 Gitea 要求赋予编辑权限。
- 不覆盖已有业务校验：已有自定义钩子由管理员保留并串联，pre-receive 必须保留任何失败的非零退出状态。
- pre-receive 从 Git 隔离区读取本次新引入仓库的所有提交；已有历史作为基线。包括新分支、Merge 和指向提交的标签。删除引用不调用校验 API。
- post-receive 从旧引用和未受本次推送影响的引用恢复基线，避免使用已经更新后的 `--all` 漏掉新提交。
- 两份钩子按最多 100 条及 512 KiB 编码后大小分批；单条说明最多 64 KiB，每次最多 10,000 个提交、1,000 个更新引用，总处理时间有上限。超限会明确提示，不静默跳过。
- pre-receive 失败时拒绝 push。post-receive 失败时 push 已成功，不会撤销；终端明确提示关联尚未完整上报，并给出带 `--commits <完整SHA...>` 的重试命令。修复后在对应 bare 仓库内执行该命令可重投未完成批次。
- 已成功上报的批次再次发送保持幂等。相同 URL 的冲突内容需要调用方修正，不能当作重试成功。
- 脚本不跟随 API 重定向、不把密钥交给环境代理，HTTPS 使用系统证书信任链。密钥不写日志、不会出现在重试命令中。
- 不改变工作项状态，不按提交中的 `fixes` / `closes` 自动关闭工作项；本集成不涉及 PR。

## 部署与验证

这批 Gitea 代码尚未部署，因此 `0130_gitea_integration.py` 已直接调整为工作空间集成、提交和关联三张表，没有保留原仓库绑定模型。部署需包含该迁移以及 API 和前端构建。仓库的 AIO 启动流程会自动执行数据库迁移。

独立钩子回归不依赖 Django、Celery 或数据库：

```sh
python3 -m unittest discover -s apps/api/plane/tests/unit/utils -p test_gitea_hook.py -v
```

相关 API 单元、数据库合同及浏览器回归覆盖跨项目、多个仓库 URL、同 URL 幂等/冲突、无效批次、权限、密钥轮换、双钩子复制下载、工作项提交分页和安全跳转。
