# src/sources —— PR / MR 追踪器

**这个目录名有歧义**：这里的 `sources` 不是「消息来源」，而是**代码托管平台**（forge）。

- 这里放的东西：GitHub / GitLab / Forge 的 PR、MR 状态查询器。
- 不在这里的东西：消息接入。消息通道在 `packages/channel/`（飞书 adapter 在那里）。

## 目录内容

| 文件 | 职责 |
|---|---|
| `github.ts` | GitHub 的 PR 状态查询（走 `gh` CLI） |
| `gitlab.ts` | GitLab 的 MR 状态查询（走 `glab` CLI） |
| `forge.ts` | 远端主机名与仓库路径的识别（GitHub / GitLab / 其它） |
| `forge-tracker.ts` | 按远端类型选择用哪个 tracker |

## 边界

- **只跟踪 PR / MR 状态**，不消费 Issue、不读评论、不回帖。
- PR 状态的变化会更新工单的 `prState`，并触发通知（见 `src/service.ts` 里的 PR 轮询）。
- 「这条消息从哪来」的问题属于消息通道，答案是 `packages/channel/src/ingress.ts`。

如果以后要加「GitHub Issue 也进工单」这类能力，那是**新功能**，不是这个目录的既有职责。

相关：[CODE-MAP.md](../../docs/CODE-MAP.md) 的 §4 与 §5。
