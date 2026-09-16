export const writingPlaneRequirements = {
  name: "writing-plane-requirements",
  description:
    "Use before drafting, creating, rewriting, or simplifying Plane work item titles and descriptions, " +
    "including requests such as 提需求. Creation includes choosing and applying labels. " +
    "Also load when the user names this skill. Changes only to status, assignees, or other metadata do not need it.",
  instructions: `# 编写简洁的 Plane 工作项

1. 沿用用户指定的标题、前缀和范围，保留理解需求必需的背景、约束和已有事实。信息不足时，只询问影响理解或执行的关键问题。
2. 用一小段话说明需求，必要时补充少量期望行为；简单需求用一两句话即可，每个要点表达一个意思。
3. 默认正文只包含需求与期望结果，不自动添加验收标准、实现方案、测试计划或开发记录。用户明确要求某类内容时按其要求补充；精简已有描述时保留重要约束和期望行为。
4. 返回或写入前，删除重复内容和未经用户要求扩展的功能，确认标题与正文表达同一目标。

## 创建时的标签

用户说“提需求”“建需求”“新增需求”或明确将工作项称为需求时，创建的工作项必须关联名称为“需求”的标签（Tag），无需用户另外说“打标签”。这是工作项的 labels 字段，标题前缀或描述中的“需求”不能代替标签。用户明确指定其他分类或要求不加标签时，按其要求执行；普通任务不自动归为需求。

以下步骤用于创建需求；其他分类按用户指定的标签执行同样的查询、写入和核实。

1. 确定目标项目后，调用 label/list 查询该项目的标签；需要继续查找时跟随 next_cursor，复用已有“需求”标签的真实 ID。完整查询后仍不存在，调用 label/create 创建“需求”标签并使用返回的 ID；创建失败时先核实是否已创建，再决定下一步。
2. 调用 workitem/create 时将“需求”的 ID 与用户要求的其他标签 ID 一并放入 labels，格式为 UUID 字符串数组，例如 labels: ["查询得到的标签 UUID"]。仅在确定无需标签时显式传入空数组 []；需要的标签无法取得时先说明阻碍，保留草稿。
3. 创建后核实工作项返回的 labels；未返回该字段时调用 workitem/retrieve 检查。缺少应有标签时，用 workitem/manage_label 的 add_label_id 补上并重新读取，保留已有标签。只有核实标签已关联，才报告完成；关联失败时说明已创建工作项但标签尚未完成，避免重复创建工作项。

仅要求草稿时返回文字；仅改写已有标题或描述时保留现有标签。

例如：
用户：提个需求，登录失败时显示错误提示。
标题：登录失败时显示错误提示
描述：登录失败时展示清晰的错误提示，并保留已填写的账号，方便用户重试。
标签：需求（使用目标项目中查询或创建得到的真实标签 ID）。`,
} as const;
