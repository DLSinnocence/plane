# PLATFORM-4 实施记录：评论独立展示，活动默认折叠

需求：[PLATFORM-4](https://task.meowalive.com/meowalive/projects/28157354-6d61-4ea5-9e27-03c6f53df206/issues/16485c2c-2793-4b36-9168-2601f13791ad)

原实施草案已落地到当前工作区。以下记录实际行为、实现位置与验证范围。

## 页面行为

```text
评论                                      排序
  评论列表
  评论输入框

▶ 活动
```

- 评论列表及有权限使用的输入框独立放在活动区上方，评论不受活动筛选影响。
- 活动作为整个区域默认折叠，展开后可查看原有活动内容，并按更新、状态或负责人筛选；创建记录继续始终显示。
- 切换工作项、项目或工作区，以及关闭后重新打开详情时，活动恢复折叠。当前工作项的数据刷新、排序及筛选不会重置展开状态。
- 排序沿用 `activity_sort_order`，对评论和活动分别按创建时间排序。升序时输入框在评论列表下方，降序时在评论列表上方，整个评论区始终在活动区上方。
- 输入框和评论卡片使用稳定 key，展开、收起活动及切换排序时保留当前评论编辑状态。切换工作项时重建编辑器，避免草稿与上传状态串项。
- 评论与活动各自处理未加载、加载为空和有数据的状态，评论就绪时不等待活动请求；保留原有取数时机及增量刷新方式。
- 折叠按钮使用真实 Propel 组件。筛选选项使用可聚焦按钮，公布选中状态；最后一个活动类别不能取消。排序按钮提供可访问标签。

## 实现位置

| 文件                                                                                                 | 改动                                                                                                 |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `apps/web/core/components/issues/issue-detail/issue-activity/root.tsx`                               | 评论和活动两个 section；活动折叠；按工作项身份重置；稳定的列表和输入框节点                           |
| `apps/web/core/components/issues/issue-detail/issue-activity/activity-comment-root.tsx`              | 分别导出 `IssueCommentList` 与 `IssueActivityList`，复用原评论卡片和活动渲染器，各组独立计算首尾位置 |
| `apps/web/core/components/issues/issue-detail/issue-activity/preferences.ts`                         | 规范化历史活动筛选与排序偏好                                                                         |
| `apps/web/core/components/issues/issue-detail/issue-activity/filter-root.tsx`、`activity-filter.tsx` | 仅保留活动筛选，修正嵌套按钮并支持键盘操作                                                           |
| `apps/web/core/components/issues/issue-detail/issue-activity/sort-root.tsx`                          | 排序按钮显示下一次切换方向的可访问标签                                                               |
| `apps/web/core/store/issue/issue-details/activity.store.ts`                                          | 新增独立 `getActivityItemsByIssueId`，复用分类和排序，保留旧混合 getter 的行为                       |
| `apps/web/core/store/issue/issue-details/comment.store.ts`                                           | 新增独立 `getSortedCommentsByIssueId`，返回原 observable 评论对象，不改变 ID 集合顺序                |

评论卡片保留原有增删改、表情、附件、访问标识、归档限制和复制链接参数。评论 DOM ID 与 `useHashScroll` 保持不变。未新增线程回复功能。

全部文案复用既有翻译键，包括 `activity_empty_state.no_comments`、`activity_empty_state.no_activity`、`common.comments`、`common.activity` 和排序、筛选文案。

`apps/web/core/components/issues/issue-detail/issue-activity/activity-collapsible.tsx` 单独管理展开状态，由根组件按工作项身份设置 key。活动筛选放在标题旁的 `trailing` 区域，仅展开时显示，避免菜单被折叠面板的 `overflow-hidden` 裁切。

## 历史偏好兼容

读取 `issue_activity_filters` 时仅保留 ACTIVITY、STATE、ASSIGNEE，去除 COMMENT、DEFAULT、重复项及未知值。

- 原有 `[COMMENT]`、空数组、缺失或错误类型：回退为全部可选活动类别。
- 原有 `[STATE]` 或 `[COMMENT, STATE]`：保留状态筛选，评论仍完整显示。
- DEFAULT 创建记录由原有筛选函数始终放行，不成为可取消的筛选选项。
- 排序值为 DESC 时保留降序，其余无效值回退 ASC；列表与输入框使用同一个有效值。

共享组件覆盖完整工作项详情、侧边预览、弹窗预览和收件箱详情。公开站点 `apps/space`、个人活动流、首页活动及后端接口、数据库结构保持原有范围。

## 验证

单元测试位于：

- `apps/web/core/components/issues/issue-detail/issue-activity/preferences.test.mjs`
- `apps/web/core/store/issue/issue-details/activity.store.test.mjs`
- `apps/web/core/store/issue/issue-details/comment.store.test.mjs`

共 13 项，覆盖历史偏好、独立加载与空态、活动分类、升降序、不修改原集合、旧混合查询兼容和 MobX 响应更新。

浏览器测试位于 `apps/web/tests/browser/issue-activity.spec.ts`。独立的 `activity.vite.config.ts` 在 4181 端口启动测试页面，复用真实 `IssueActivity`、评论卡片、评论创建表单、活动渲染器、localStorage/hash hooks、菜单和 Propel 折叠组件；替换业务 store/操作和富文本编辑器叶子。该页面与既有浏览器夹具隔离。

主要交互覆盖默认折叠、完整展开、键盘与 ARIA、区域顺序、筛选隔离、旧偏好、独立加载、空态、工作项切换、排序、草稿保留、只读行为和评论链接定位。

首次在干净工作区运行时，先执行 `pnpm install --frozen-lockfile` 和 `pnpm turbo run build --filter='web^...'`，准备测试引用的共享包产物；Playwright 还需要已安装的 Chromium。

```bash
# 仓库根目录
node --test apps/web/core/components/issues/issue-detail/issue-activity/preferences.test.mjs apps/web/core/store/issue/issue-details/activity.store.test.mjs apps/web/core/store/issue/issue-details/comment.store.test.mjs
pnpm --filter web test:browser tests/browser/issue-activity.spec.ts
pnpm --filter web check:types
pnpm --filter web build
```

本轮验证结果：

- 单元测试：13 项通过。
- 浏览器测试：本次新增 21 项通过，包括窄屏、空活动时筛选菜单所有选项可点击；同时运行已有 `stage-assignees.spec.ts` 的 3 项测试，合计 24 项全部通过。
- `pnpm --filter web check:types`：通过，包含路由类型生成及浏览器测试类型检查。
- `pnpm --filter web build`：通过。
- 全部改动文件格式检查、改动代码严格 lint 检查：通过，lint 无警告、无错误。

浏览器夹具验证真实组件交互，未连接真实后端，因此不代替各详情路由、后端授权及真实上传链路的整站验收。
