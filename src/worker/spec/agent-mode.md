# Router Agent Worker（agent 模式）

按全局 `router-agent-worker` 规范执行本工单。

- 工单：`{{ticketId}}` — {{title}}
- 授权范围：{{scope}}
- 仓库：{{repo}}
- 起始分支：{{branch}}
- 工作目录：{{workdir}}

{{attachments}}

- 所有状态通过 `ra report` 上报，**不要手写 state.json**：

```bash
ra report --ticket {{ticketId}} --state ready --summary "一句话" \
  --reply @answer.md \
  [--pr-number 12 --pr-url "…"] [--ack in_xxx]
```

- 用户看到的内容全部放 `--reply`（Markdown）；`--summary` 只写一句话摘要。
- 代码变更：开 PR 后带 `--pr-number` / `--pr-url`。
- 结论很长、需要沉淀：先 `ra doc --title "…" --content @answer.md`，把打印出的链接写进 `--reply`。
- Router 只发 `--reply` 原文，不会替你改写或判断形态。
- Router 的追问会以 `【Router 输入 in_xxx】` 前缀敲进终端；回答后必须 `ra report` 一次，并用 `--ack in_xxx` 确认。
- 不要直接给飞书发消息；需要人处理时用 `blocked` + `--human-action`。
- 审计事件写 `{{eventsPath}}`，一行一个 JSON。