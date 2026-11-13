# `ra reply` 上报协议

`ra reply` 是 Worker 的唯一对外通道：把状态与回复交给本地 Router，Router 再投到发起人所在的话题。

## 参数

```bash
ra reply --ticket tk_x \
  [--state ready|progress|waiting|blocked|failed|dropped]   # 缺省 ready
  [--summary "一句话"] \
  [--body @answer.md | - | "文本"] \
  [--kind auto|text|markdown|image|images|pr|doc|ask]        # 缺省按入参推断
  [--image before=./a.png] [--image after=./b.png]           # 可重复，最多 6 张
  [--pr 42 --pr-url <url>] [--ui-change [true|false]] \
  [--ask --question "..."] [--option "A|说明"] [--option "B|说明"] [--multi] \
  [--ack in_x] [--port <n>]
```

| 参数 | 说明 |
| --- | --- |
| `--ticket` | 工单 ID，必填 |
| `--state` | 上报状态；缺省 `ready`。`progress` 是中途进展，Router 会合并后同步到话题 |
| `--summary` | 一句话摘要，给日志和列表用，必填 |
| `--body` | 要发给发起人的完整回复：字面量 / `@文件` / `-`（stdin） |
| `--kind` | 交付形态；`auto` 按入参推断，推断不出会报错 |
| `--image` | 图片路径，可重复；`before=` / `after=` 前缀会生成对应图注 |
| `--pr` / `--pr-url` | PR / MR 编号与链接；`--kind pr` 时至少要有一个 |
| `--ui-change` | 显式声明本次改动是否涉及 UI；不传时 Router 按改动文件推断 |
| `--ask` | 提问模式；必须同时给 `--question` 和两个以上 `--option` |
| `--option` | 选项，格式 `标识|说明`；`--ask` 下可重复 |
| `--multi` | 允许多选 |
| `--ack` | 确认已读的输入 ID，可重复 |
| `--port` | Router 端口；缺省读 `config/server.port` 或 `RA_PORT` |

## kind 与必填

| kind | 必填 | 行为 |
| --- | --- | --- |
| `auto` | `body` / `image` / `ask` 之一 | 按入参推断 |
| `text` | `body` | 纯文本 |
| `markdown` | `body` | 富文本卡片 |
| `image` / `images` | `image` | 单图 / 多图 |
| `pr` | `pr` 或 `pr-url` | PR 对比卡片，可叠加图片 |
| `doc` | `body` | 先建飞书文档再回链接 |
| `ask` | `question` + 两个以上 `option` | 建问并出 `q_x` |

## 退出码

| 码 | 含义 | 该怎么办 |
| --- | --- | --- |
| 0 | 成功（HTTP 已上报） | 正常 |
| 2 | 参数错误 | 按 stderr 提示改参数后重试 |
| 1 | 服务端拒绝 | stderr 会带原因；422 多半是 UI 证据不足 |
| 3 | 服务不可达 | 已落盘 `state.json`，Router 轮询后生效；不必重试 |

## 写法

- `--summary` 只放一句话；**用户真正看到的内容全部放 `--body`**。
- 直接给结论，不要只写「我做了什么」的过程。
- Markdown 可以直接用：Router 会以飞书卡片渲染标题、列表、链接、代码块。
- 正文长时用文件，避免 shell 转义：

```bash
ra reply --ticket {{ticketId}} --state ready --summary "完成梳理" --body @/tmp/answer.md
```

- `--body` 超过单条消息长度会自动分块，不会截断。

## 兼容

- `ra report` 保留为隐藏别名，参数原样映射，会打一行弃用提示。
- `ra doc` 保留；`--kind doc` 已覆盖它的能力。

