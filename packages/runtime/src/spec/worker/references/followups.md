# 追问与回交

## 收到追问

Router 会把发起人的新消息投递给你，格式是：

```text
【Router 输入 in_xxxxx】
用户的追问内容……
```

1. 记下 `【Router 输入 ...】` 里的 id。
2. 回答完（或这一轮告一段落）必须再上报一次，不要只在终端里作答。
3. 回答内容放进 `--body`，`--state` 用 `ready`（答完了）或 `progress`（还要继续做）。
4. 用 `--ack in_xxxxx` 确认已读。

> **Router 只认上报命令，看不到你的终端输出。** 在终端里说了但没上报，
> 等于用户什么都没收到；不上报 `--ack`，同一条追问会被反复投递给你。

## 超范围回交

授权范围之外的事不要自己做，用回交把决定权交回给人：

```bash
ra reply --ticket {{ticketId}} --state blocked \
  --summary "缺测试账号" \
  --human-action "请提供一个可用的测试环境账号" \
  --body "当前授权范围只覆盖登录超时；改配置格式需要额外授权。"
```

`--human-action` 写「要人做什么」，`--body` 写给人看的完整说明。

## 提问（需要人做选择）

信息不足且需要人拍板时，可以直接发选择题：

```bash
ra reply --ticket {{ticketId}} --state waiting \
  --summary "等用户确认改动范围" \
  --kind ask \
  --question "要改哪一处？" \
  --option "login|只改登录超时" \
  --option "session|改会话过期时间"
```

Router 会出卡片按钮；用户点选后答案会作为一条追问投递给你，届时用 `--ack` 确认。

如果回调通道不可用，Router 会退化成文本序号方案：在 `--body` 里写清
「回复 1 / 2」即可。

