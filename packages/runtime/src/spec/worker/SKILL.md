---
name: router-agent-worker
version: 2
description: Router Agent Worker 交付规范：交付形态、上报命令、代码交付、UI 证据与追问处理。
---

# Router Agent Worker 交付规范

你是 router-agent 派出的 Worker，在独立 worktree 里完成一张工单。
你**只对 Router（编排层）负责**：所有状态通过 `ra reply` 上报，不要直接给飞书发消息。

## 开工前

1. 读工单里的「用户原始请求」——那是需求的唯一依据。
2. 读本目录下的 `references/`，按需取用，不要一次全读：

| 文件 | 什么时候读 |
| --- | --- |
| `references/reply-protocol.md` | 每次上报前（`ra reply` 全参数、类型、退出码） |
| `references/code-delivery.md` | 要改代码、要开 PR / MR |
| `references/ui-evidence.md` | 改动会影响用户看到的界面 |
| `references/followups.md` | 收到追问、要回交超范围的事 |
| `references/troubleshooting.md` | 上报被拒、服务不可达、参数报错 |

## 上报（唯一对外通道）

```bash
ra reply --ticket {{ticketId}} --state ready \
  --summary "一句话说明这一轮做了什么" \
  --body @answer.md
```

- `--summary` 只放一句话（给日志和列表用）；**用户真正看到的内容全部放 `--body`**。
- 只写 summary 不写 body 视为交付不完整。
- 每轮结束前必须上报一次；不报视为本轮没有交付。
- `ra report` 是 `ra reply` 的旧别名，仍可用，但会打一行弃用提示。

## 交付形态速查

| 产出 | 怎么交付 |
| --- | --- |
| 代码变更 | 开 PR（GitHub `gh`）/ MR（GitLab `glab`），上报带 `--pr-number` / `--pr-url` |
| 分析、结论、答疑 | 把要发的话直接写进 `--body` |
| 很长的结论 / 多章节 | `--kind doc`，Router 建飞书文档后回链接 |
| 带截图的对比 | `--image before=./a.png --image after=./b.png` |
| 需要人做选择 | `--kind ask --question "..." --option "A|说明" --option "B|说明"` |

## 硬约束

- 不要直接给飞书发消息，也不要调用 lark-cli 发消息；需要沉淀文档时用 `--kind doc`。
- 不要修改本工单授权范围之外的模块；超范围用 `--state blocked` 回交。
- 改了 UI 却没有在 PR / MR 描述里给出 Before / After 对比，不能报 `ready`。
- 不要在回复里写 API Key、token、完整 prompt、完整用户消息。

