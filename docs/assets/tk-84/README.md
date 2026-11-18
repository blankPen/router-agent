# tk-84 界面 Before / After

## 自动化页（本单）

同一场景（面板「收件箱」页展示左侧菜单）、同一视口（1440×900）、同一主题（浅色）。基线是起始分支 `beta` 的 `de3c88e`，改动版是本分支。

| 截图 | 说明 |
|-|-|
| `automation/before-nav.png` | 改造前：左侧菜单只有「收件箱 → 工单」，没有自动化入口 |
| `automation/after-nav.png` | 改造后：「自动化」插在「收件箱」与「工单」之间，其余菜单顺序不变 |
| `automation/after-automation.png` | 改造后：自动化页「任务」Tab，含来自飞书的待确认草稿与正式任务卡片 |
| `automation/after-automation-modal.png` | 改造后：「新建自动化」弹窗，沿用「添加决策规则」的分段、间距与字段层级 |
| `automation/after-automation-draft.png` | 改造后：草稿进入同一个编辑弹窗，保存后才写正式任务 |
| `automation/after-automation-runs.png` | 改造后：「执行记录」Tab，展示状态、耗时、结果摘要与产出跳转信息 |
| `automation/after-automation-dark.png` | 改造后：同页深色主题，确认新增样式复用既有 token |

截图取自真实构建产物（`pnpm build`）与本地临时 home（`/tmp/ra-tk-84-home`，端口 3199），
示例任务与执行记录只用于展示布局，不含真实用户数据与凭据。

## 日志体系改造（历史截图）

同一场景（面板「日志」页读同一条日志文件）、同一视口（1440×900）、同一主题（浅色 / 深色各一组）。

基线版本是 `origin/main`（e4cdee0，含 tk-12 的排查助手重构），改动版本是该分支。

| 截图 | 说明 |
|-|-|
| `before-logs-light.png` | 改造前（浅色）：日志是一行行原始字段，看不出「哪个群、谁触发的、用户还是机器人、Orca 还是 Codex、消息还是事件」 |
| `after-logs-light.png` | 改造后（浅色）：日志是一张表，列为「时间 / 级别 / 类别 / 事件 / 群 / 发起人 / 运行时 / 工单 / 详情」 |
| `before-logs-dark.png` | 改造前（深色）：同场景的深色基线 |
| `after-logs-dark.png` | 改造后（深色）：同场景的深色改动版 |
| `after-logs-expanded.png` | 改造后：点事件名展开这一行，标签右对齐、值左对齐，能看到该事件的全部字段与原始值 |
| `after-logs-filter-chat.png` | 改造后：按「群 = 研发三组」筛选，维度菜单里显示群名而不是群 ID |
| `after-logs-filter-chat-category.png` | 改造后：「群 + 类别 = 消息」两级筛选，只剩该群里的用户消息 |

两张日志文件内容完全一致（同一批事件、同一组时间戳）：基线文件按 `main` 的日志格式写，改动文件按新结构写，
这样 Before / After 比的是「日志体系 + 面板」的差别，而不是两批不同的数据。

截图取自真实构建产物（`pnpm build:web`）与真实日志读取实现（`readLogs`），
改动版日志文件由服务日志实现（`createLogger`）写出，不含真实用户数据与凭据。
