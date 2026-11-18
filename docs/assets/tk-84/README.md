# tk-84 界面 Before / After

## 自动化页（本单）

同一场景（面板「收件箱」页展示左侧菜单）、同一视口（1440×900）、同一主题（浅色）。基线是起始分支 `beta` 的 `de3c88e`，改动版是本分支。

| 截图 | 说明 |
|-|-|
| `automation/before-nav.png` | 改造前：左侧菜单只有「收件箱 → 工单」，没有自动化入口 |
| `automation/after-nav.png` | 改造后：「自动化」插在「收件箱」与「工单」之间，其余菜单顺序不变 |
| `automation/before-automation-tasks.png` | 修复前：脚本自动化卡片看不出有没有脚本，也没有「生成脚本」入口 |
| `automation/after-automation.png` | 改造后：自动化页「任务」Tab。任务卡片显式说明脚本状态（「脚本已就绪（168 行），定时执行跑的就是这份」），操作按钮换行不撑破卡片 |
| `automation/after-automation-modal.png` | 改造后：「新建自动化」弹窗，沿用「添加决策规则」的分段、间距与字段层级 |
| `automation/after-automation-draft.png` | 改造后：草稿进入同一个编辑弹窗，保存后才写正式任务 |
| `automation/before-runs.png` | 修复前：「执行记录」Tab 没有阶段列、没有「查看日志」入口，长摘要不截断 |
| `automation/after-automation-runs.png` | 改造后：「执行记录」Tab。执行中显示实时阶段（正在启动运行时 / 正在执行 / 正在收集产出）、结果摘要按行截断、每行带「查看日志」深链；服务重启中断的记录标为「失败」而不是永远挂在「执行中」 |
| `automation/after-automation-dark.png` | 改造后：同页深色主题，确认新增样式复用既有 token |

截图取自真实构建产物（`pnpm build`）与本地临时 home（`/tmp/ra-tk84-fix`，端口 3197），
示例任务与执行记录只用于展示布局，不含真实用户数据与凭据。

「执行记录」那张来自真实执行：手动触发 → runtime 在目标项目的 worktree 里跑脚本 →
agent 写 `.automation-result` → 收尾，全程 23 秒。中间几行是更早的排查记录（含服务重启被中断的），
用来展示状态与阶段列的真实形态。

`before-runs.png` / `before-automation-tasks.png` 取自本单修复前的构建（`16013de`），
同一场景、同一视口、同一主题，用来比「有没有阶段列 / 脚本状态 / 日志入口」这类差别。

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
