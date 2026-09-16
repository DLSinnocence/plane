# PLATFORM-6 实施记录：上传图片附件直接预览

关联需求：[PLATFORM-6](https://work.meowalive.com/?plane_project=28157354-6d61-4ea5-9e27-03c6f53df206&plane_item=a9ce7e9c-4606-47d9-a824-203d134cb99e)

实现已写入当前工作区。使用方式见 `docs/attachment-templates.md`；本文记录实现位置、文件访问方案和验证范围。

## 页面行为

- JPG／JPEG、PNG、GIF、WebP 附件直接显示缩略预览，无需点击；点击缩略图或文件名后放大查看。按原始文件名的末尾扩展名判断，忽略大小写，不从附件行名称或资产 URL 猜测格式。
- 支持正式工作项附件行、非普通工作项的旧附件列表和收件箱卡片；完整详情和快速预览复用相同实现。
- 可视区域内自动加载约 128px 高的缩略图，屏幕外使用浏览器懒加载。缩略图和大图均使用原生 `<img>` 保持比例与 GIF 动画；图片行随内容增高，非图片行保持紧凑布局。
- 提供加载提示、失败提示、重试、关闭和打开原文件；重试继续使用原始地址，不修改签名参数，不通过 Blob／Base64 转换图片。
- Escape、关闭按钮、遮罩只关闭图片，底层快速预览保留，焦点返回文件入口。弹窗内部点击不会关闭工作项。
- 保留修饰键点击、新标签页、非图片附件及原文件打开／下载行为。文件操作不会冒泡打开上传选择器；旧列表的文件链接与删除菜单使用独立元素。
- 预览不依赖编辑权限。当前数据中附件删除、替换或切换工作项后立即移除预览，并清理选择；图片异步结果不串到新文件。

SVG、PDF、Office、音视频、图集切换、服务端缩略图生成及图片编辑未纳入本次范围。描述和评论的编辑器图片继续使用已有机制。

## 实现位置

| 文件                                                                                              | 职责                                                                                                            |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `packages/ui/src/images/image-thumbnail.tsx`                                                      | 自动显示原图缩略预览、保持比例、加载和失败提示，来源变化时清理旧状态；配套 Storybook 提供正常、加载和错误场景。 |
| `packages/ui/src/modals/image-preview-modal.tsx`                                                  | 通用图片预览，复用 `ModalCore` 与 Dialog 焦点管理；图片来源和重试分别隔离状态，处理加载、失败与缓存完成事件。   |
| `packages/ui/src/modals/image-preview-modal.stories.tsx`                                          | 正常、加载、错误、长文件名的独立展示场景。                                                                      |
| `apps/web/helpers/attachment-preview.ts`                                                          | 集中判断是否可尝试图片预览；文件名仅决定展示方式，不宣称验证文件内容。                                          |
| `apps/web/core/components/issues/attachment/file-link.tsx`                                        | 共用原文件链接，拦截图片的普通点击，保留修饰键行为并隔离 dropzone 点击。                                        |
| `apps/web/core/components/issues/attachment/use-attachment-preview.tsx`                           | 每个区域一个弹窗；根据当前附件集合、文件 ID、原始地址及工作项身份派生选择。                                     |
| `apps/web/core/components/issues/attachment/slots.tsx`                                            | 正式工作项统一附件行入口。                                                                                      |
| `apps/web/core/components/issues/attachment/attachment-item-list.tsx`、`attachment-list-item.tsx` | 旧列表入口，按 `issueServiceType` 读取附件，并拆开文件链接和操作菜单。                                          |
| `apps/web/core/components/issues/attachment/attachments-list.tsx`、`attachment-detail.tsx`        | 收件箱卡片入口；文件扩展名改为从原文件名读取。                                                                  |
| `packages/i18n/src/locales/*/common.json`                                                         | 20 个语言包的加载、错误、重试、关闭和打开原文件文案。                                                           |

通用预览通过 `@plane/ui` 导出，业务代码通过参数提供来源、名称、关闭回调和文案。选择保存在区域局部状态，不新增全局 MobX UI 状态或网络接口。

## 文件访问与后端范围

本次使用 `asset_url` 经 `getFileURL` 处理后的原有受保护地址，不修改后端、数据库或上传流程。

`apps/api/plane/app/views/issue/attachment.py:223` 的附件 GET 检查项目角色及文件归属，并重定向至签名对象存储地址。同源 `<img>` 请求可携带现有会话 Cookie；跨源普通图片展示无需额外添加 `crossOrigin`。当前签名设置 `Content-Disposition: attachment`，最终 MIME 由对象元数据提供。已用 Chromium 与测试内临时 HTTP 服务验证携带 Cookie、跨端口请求、302 跳转和该下载响应头下的图片解码，同时验证原链接仍可下载原文件；因此本次沿用现有接口。

不使用公开静态资产端点或通用工作空间下载端点替代正式工作项附件地址，也不将 SVG／HTML 等类型切换为 inline。前端格式白名单不代替服务端授权或文件内容校验。

已有权限差异仍需注意：附件 GET 的常规项目角色检查没有像附件行读取那样额外检查活跃工作空间成员和有效父级。本次未调整该行为。已经发出的对象存储签名 URL 在过期前仍可能有效；关闭前端预览不等于立即撤销存储访问。

## 验证

新增 helper 单元测试位于 `apps/web/helpers/attachment-preview.test.mjs`，浏览器测试位于 `apps/web/tests/browser/attachment-preview.spec.ts`。原有 store 和浏览器夹具缺少当前工作流权限依赖，已补齐测试上下文并在浏览器夹具中复用真实权限计算；生产 store 与权限规则未变更。

浏览器夹具使用三类真实附件入口、共享弹窗、生产 Tailwind 样式及快速预览的关闭处理。覆盖原生图片解码和 GIF 动画、只读入口、加载失败／损坏文件、重试、缓存图片、修饰键点击、原文件操作、键盘焦点、遮罩关闭、异步文件变更、长图及窄屏长文件名。

已通过的检查：

- 新增格式判断及既有附件上传、替换、删除、异步响应和快速预览回归：36 项。
- 浏览器测试：预览 51 项及既有附件行 35 项，共 86 项通过；覆盖无需点击的缩略预览、点击放大、GIF 动画与替换后的缩略图恢复。
- Web 与 `@plane/ui` 类型检查。
- 共享依赖构建与 Web 生产构建。
- 20 个语言包的新增键与非空文案校验。
- 受影响生产代码的严格 lint 检查及语言文件格式检查。

HTTP 用例使用真实本地响应模拟文件协议，包括原文件下载和会话 Cookie 缺失时的新页面读取失败；已经解码的图片可以留在原页面的浏览器缓存中，不以清除 Cookie 后的旧页面行为证明即时撤权。测试没有连接实际 Django、S3／MinIO 或部署环境的 Cookie／CSP 配置，也未覆盖其他浏览器引擎。本次未部署。

主要复现命令（仓库根目录）：

```sh
pnpm install --frozen-lockfile
pnpm turbo run build --filter='web^...'
node --test apps/web/helpers/attachment-preview.test.mjs apps/web/helpers/attachment-peek.test.mjs apps/web/helpers/attachment-upload.test.mjs apps/web/core/components/issues/attachment/slot-helpers.test.mjs apps/web/core/store/issue/issue-details/attachment.store.test.mjs apps/web/core/services/issue/issue_attachment.service.test.mjs
pnpm --filter web exec playwright install chromium
pnpm --filter web test:browser tests/browser/attachment-preview.spec.ts tests/browser/attachment-slots.spec.ts
pnpm --filter web check:types
pnpm --filter @plane/ui check:types
pnpm --filter web build
```
