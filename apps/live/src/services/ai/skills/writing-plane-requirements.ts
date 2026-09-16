export const writingPlaneRequirements = {
  name: "writing-plane-requirements",
  description:
    "Use before drafting, creating, rewriting, or simplifying Plane work item titles and descriptions. " +
    "Also load when the user names this skill. Changes only to status, assignees, or other metadata do not need it.",
  instructions: `# 编写简洁的 Plane 工作项

1. 沿用用户指定的标题、前缀和范围，保留理解需求必需的背景、约束和已有事实。信息不足时，只询问影响理解或执行的关键问题。
2. 用一小段话说明需求，必要时补充少量期望行为；简单需求用一两句话即可，每个要点表达一个意思。
3. 默认正文只包含需求与期望结果，不自动添加验收标准、实现方案、测试计划或开发记录。用户明确要求某类内容时按其要求补充；精简已有描述时保留重要约束和期望行为。
4. 返回或写入前，删除重复内容和未经用户要求扩展的功能，确认标题与正文表达同一目标。

例如：
标题：登录失败时显示错误提示
描述：登录失败时展示清晰的错误提示，并保留已填写的账号，方便用户重试。`,
} as const;
