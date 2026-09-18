# Gitea 工作项单号校验与提交链接关联

集成按工作空间鉴权，工作项由完整单号定位。项目与代码仓库没有绑定关系：同一代码仓库可以引用工作空间内多个项目的单号，同一工作项也可以关联多个仓库中的提交。关联使用调用方上报的完整提交 URL。

## 接入流程

1. 在 **工作空间设置 → 集成 → Gitea** 中启用集成，点击 **生成 Hook 代码**。
2. 页面直接显示两份完整代码。点击 **复制 pre-receive**，粘贴到 Gitea 仓库 **设置 → Git 钩子 → pre-receive** 编辑框并保存。
3. 点击 **复制 post-receive**，粘贴到同一仓库的 **post-receive** 编辑框并保存。
4. 同一工作区的其它仓库使用相同两份代码即可，无需手填 API/仓库地址，也无需逐仓库重新生成。

生成的代码使用 **`/bin/sh`、Git、curl 和 POSIX/BusyBox 标准工具（含 timeout）**，并要求 Gitea 允许自定义 Git Hooks。官方 Gitea Docker 镜像已包含这些工具，无需额外安装 Python 或 jq。已有其它自定义钩子逻辑时应保留并串联。

pre-receive 在接收推送前校验工作项编号；post-receive 在推送成功后自动识别当前仓库并上报提交链接。

Gitea 的 HTTP 和 SSH 推送会提供 `GITEA_ROOT_URL`、`GITEA_REPO_USER_NAME` 和 `GITEA_REPO_NAME`。脚本利用这些变量拼接仓库首页及提交链接，保留部署子路径。例如站点地址 `https://git.example/gitea/`、所有者 `team`、仓库 `shared-code` 对应仓库浏览地址 `https://git.example/gitea/team/shared-code`。这个地址只用于跳转，不参与项目绑定或工作项定位。

也可以直接调用下面的 API，无需使用生成的钩子。上报端只要提供提交 URL，即可来自不同仓库；不需要先登记仓库，也不需要 `repository_id`。

例如同一次推送可以包含：

```text
SHOP-123 fix: 修复订单保存
OPS-45 chore: 更新部署配置
```

API 根据 `SHOP`、`OPS` 定位当前工作空间中的对应项目，再按工作项序号查真实记录。首行格式为完整单号、空格或 Tab、非空提交说明。

只有当前状态属于 **进行中（`started`）** 分组的工作项允许推送和提交上报，包括默认的 **开发中**、**开发完成/待验收** 及同组自定义状态。待规划、待开始、已完成、已拒绝/取消、待处理、无状态、已删除状态或已归档的工作项都拒绝；草稿和已删除工作项仍不可使用。

拒绝时返回 `work_item_not_in_progress`，说明中包含工作项编号和实际状态。推送内只要有一个新提交引用了不符合条件的工作项，整个推送就会被 pre-receive 拒绝。此规则由 Plane API 根据实时状态执行，后端更新后，已经接入的 hook 无需重新生成。状态改回进行中后可重新推送。

已经保存的提交关联仍可在工作项完成后查看；查询接口不受这个推送限制影响。

## 部署提交免单号（无需替换 Hook）

提交标题以精确、区分大小写的 `[deploy]` 开头时，API 直接通过工作项校验，例如：

```text
[deploy] publish Godot Web
```

这类提交不保存提交记录、不创建工作项关联，上报接口仍成功确认其 SHA。JSON 和 shell multipart 接口均支持；部署更新后的 Plane API 即可生效，已有 pre-receive、post-receive 无需修改或重新生成。部署流程需要使用上述提交标题。

这是按提交标题豁免，适用于所有分支和提交者，并不验证目标为 `gh-pages` 或来源为 Gitea Actions。`[DEPLOY]`、前面带空格或只在正文出现 `[deploy]` 不豁免。同批其它提交继续校验单号及工作项状态，任何一条不通过仍拒绝整批，且不上报部分关联。集成鉴权及请求格式校验仍然有效。

## 密钥

所有外部校验、上报和查询接口使用同一个工作空间集成密钥：

```http
Authorization: Bearer <workspace-integration-secret>
```

密钥自动生成、加密保存，管理员主动生成钩子时才嵌入返回的脚本。它具有该工作空间的单号查询及提交关联写入权限，不是 Gitea 访问令牌。

旋转密钥后，需要重新生成并替换该工作空间已安装的两份钩子。停用后，旧 pre-receive 会校验失败并拒绝 push；停用前应安排移除或替换钩子。

## 旧 Hook 提示找不到 python3

`env: can't execute 'python3': No such file or directory` 表示旧版 Hook 的 Python 解释器在 **Gitea 容器内**不存在，脚本还没运行到工作项校验；本地开发电脑安装 Python 不会改变远端环境。

更新 Plane API/前端后，在集成页面重新点击 **生成 Hook 代码**，将新的两份完整代码分别替换 Gitea 仓库中的 pre-receive 与 post-receive 并保存，然后重新推送。新代码第一行是 `#!/bin/sh`，不再启动 Python。

必须先更新 Plane API，再替换 Hook，因为新代码使用下面说明的 multipart/纯文本协议；旧的 JSON API 继续兼容，仍装有 Python 的旧 Hook 也可继续使用。不要仅改旧脚本第一行：Python 代码不能直接交给 sh 执行。

如果必须立即恢复旧 Hook，管理员可在现有 **Alpine 官方 Gitea 容器**内临时安装 Python 3，例如 `docker compose exec --user root gitea apk add --no-cache python3`（`gitea` 替换为实际服务名）。容器重建后临时安装会丢失；推荐更新并复制新版 shell Hook。

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
- 整批先完成单号、当前状态和字段校验，再原子保存。存在无效条目时返回错误，该批不部分落库。直接上报也不能绕过状态限制；如果工作项在推送校验后变为已完成或已拒绝，上报会明确失败，已接受的 Git 推送不会被撤销。

成功响应包含 `valid: true`、逐提交 `results`（含工作项及反向 URL）和 `linked_count`。

此接口信任持有工作空间密钥的调用方仅上报已成功推送的提交。它无法仅通过提交 URL 证明远端 push 已发生，也不会调用 Gitea REST 验证。生成的 post-receive 由 Git 在成功推送后触发，负责保证正常接入流程中的调用顺序。

## 生成的 shell Hook 协议

生成的代码调用同样的校验和上报地址，使用 `multipart/form-data`，无需在 Gitea 内拼接或解析 JSON。每个重复 `commits` 文件字段以完整 SHA 为文件名，内容是 `git cat-file commit <SHA>` 输出的原始提交对象；上报时另带 Gitea 站点、所有者、仓库名或显式仓库 URL。Plane 校验原件哈希、提取完整提交说明、作者和时间后复用现有工作项校验与原子关联逻辑。

成功响应为 `text/plain`，依次包含 `PLANE-HOOK-OK`、按请求顺序的全部 SHA、`PLANE-HOOK-END`，上报成功还包含工作项链接。Hook 同时校验 HTTP 状态、首尾标记和每个 SHA，无法把登录 HTML、重定向或不完整响应误当成成功。校验失败返回 HTTP 400、`PLANE-HOOK-ERROR` 和安全的具体原因；旧 JSON API 的行为保持兼容。

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

| 方法和路径                                                     | 用途                                                        |
| -------------------------------------------------------------- | ----------------------------------------------------------- |
| `GET /api/workspaces/{slug}/integrations/gitea/`               | 获取启用状态、密钥是否已配置及 API 地址                     |
| `PATCH /api/workspaces/{slug}/integrations/gitea/`             | 以 `{ "enabled": true }` 启用，首次自动生成密钥；false 停用 |
| `POST /api/workspaces/{slug}/integrations/gitea/rotate-token/` | 旋转工作空间集成密钥                                        |
| `POST /api/workspaces/{slug}/integrations/gitea/hooks/`        | 以 `{}` 生成当前工作区的通用两份钩子 JSON                   |

配置响应为 `enabled`、`has_secret`、`validation_url`、`commits_url`、`lookup_url` 和 `issue_url_template`，不包含仓库 ID、项目绑定或密钥明文。设置页面不再逐项展示这些地址，生成的代码会自动包含所需配置。

hooks 响应包含 `pre_receive`、`post_receive` 两个对象，各有 `filename`、`content`。页面直接展示 `content` 并提供复制按钮。响应禁止缓存，只有启用集成的工作区管理员能访问。

既有 API 客户端仍可显式传入 `{ "repository_url": "https://git.example/team/repo" }`，用于无法提供 Gitea 标准环境变量的特殊环境。该地址只在本次生成请求中使用，不保存为工作区配置；正常页面生成代码无需传入。

## 钩子运行和故障处理

- Plane 的 `APP_BASE_URL` 或 `WEB_URL` 应为 Git 服务器实际可访问的地址。Git 服务器调用 Plane，Plane 不需要访问 Git 服务器。
- 在 Gitea **设置 → Git 钩子** 编辑器中分别粘贴两份完整代码并保存。实例需允许自定义 Git Hooks；默认关闭时，管理员需设置 `[security] DISABLE_GIT_HOOKS = false` 并按 Gitea 要求赋予编辑权限。已有自定义逻辑应保留并串联，pre-receive 必须保留任何失败的非零退出状态。
- pre-receive 从 Git 隔离区读取本次新引入仓库的所有提交；已有历史作为基线。包括新分支、Merge 和指向提交的标签。删除引用不调用校验 API。
- post-receive 从旧引用和未受本次推送影响的引用恢复基线，避免使用已经更新后的 `--all` 漏掉新提交。
- 两份钩子按最多 100 条及 512 KiB 原始提交对象分批；单条提交对象最多 128 KiB、说明最多 64 KiB，每次最多 10,000 个提交、1,000 个更新引用，总处理时间为 120 秒上限。超限会明确提示，不静默跳过。
- pre-receive 失败时拒绝 push。post-receive 失败时 push 已成功，不会撤销；终端明确提示关联尚未完整上报，并给出带 `sh <hook> --commits <完整SHA...>` 的重试命令。命令会保留经本地检查的 Gitea 仓库环境变量，或 `PLANE_GITEA_REPOSITORY_URL`，复制到新的 shell 后仍可重试，不包含工作区密钥。
- 正常代码仓库推送自动使用 Gitea 的站点、所有者及仓库名环境变量，不猜测裸仓库的 `origin`。直接调用 Git 或使用自定义 wrapper 时，如果这些变量缺失，需要显式设置 `PLANE_GITEA_REPOSITORY_URL`；缺失或非法信息会明确报错，不会上报虚假的仓库地址。这两份代码用于普通代码仓库。
- 已成功上报的批次再次发送保持幂等。相同 URL 的冲突内容需要调用方修正，不能当作重试成功。
- 脚本不跟随 API 重定向、不读取 curl 默认配置、不把密钥交给环境代理，HTTPS 使用系统证书信任链。密钥通过私有临时 header 文件传给 curl，不写进 curl 进程参数或日志，也不会出现在重试命令中；临时目录在退出时清理。
- 不改变工作项状态，不按提交中的 `fixes` / `closes` 自动关闭工作项；本集成不涉及 PR。

## 部署与验证

部署时需更新 API 和前端，并执行仓库现有数据库迁移；AIO 启动流程会自动执行迁移。本次通用 hook 代码生成使用已有工作区集成配置。

自动识别依据 Gitea 官方的[环境变量定义](https://github.com/go-gitea/gitea/blob/v1.24.6/modules/repository/env.go#L16-L80)、[SSH 推送注入](https://github.com/go-gitea/gitea/blob/v1.24.6/cmd/serv.go#L339-L351)及 [HTTP 推送注入](https://github.com/go-gitea/gitea/blob/v1.24.6/routers/web/repo/githttp.go#L175-L181)。Gitea 会通过自己的[钩子分派机制](https://github.com/go-gitea/gitea/blob/v1.24.6/modules/gitrepo/hooks.go#L17-L74)执行仓库设置中的自定义钩子。

独立钩子回归不依赖 Django、Celery 或数据库：

```sh
python3 -m unittest discover -s apps/api/plane/tests/unit/utils -p test_gitea_hook.py -v
```

相关 API 单元、数据库合同及浏览器回归覆盖跨项目、多个仓库 URL、同 URL 幂等/冲突、无效批次、权限、密钥轮换、双钩子代码生成和复制、工作项提交分页和安全跳转。
