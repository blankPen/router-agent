# trove CLI 参考

所有命令只读（`trove index build` 只写本地缓存 `~/.trove/cache/`）。

## 用户信息

```bash
trove whoami
trove whoami --sections profile,recent --json
trove whoami --full          # 包含年龄/人际关系
```

## 经验（lessons）

```bash
trove lessons search "飞书 编辑"
trove lessons search "AICR 评审" --category entities --since 90d --limit 5
trove lessons list --category experiences --limit 20
trove lessons show experiences/gotcha-feishu-edit-button-hit-testing.md
trove lessons show preferences/profile.md --section 我是谁
trove lessons show <path> --lines 1-80 --full
```

参数：

- `--category`：`preferences` / `entities` / `experiences` / `events` / `resources`
- `--type`：记忆类型，如 `experiences/gotcha`
- `--since`：`7d` / `90d` / `2026-10-01`
- `--limit`：search 默认 10，最大 50；list 默认 50，最大 100
- `--json`：机器可读

## 历史会话（sessions）

```bash
trove sessions search "知识库 消费层"
trove sessions search "SignatureDoesNotMatch" --exact
trove sessions search "trove clean" --harness claude-code --since 30d
trove sessions show 7d0100c4-d324-4f63-9282-... --around SignatureDoesNotMatch --limit 6
```

参数：

- 默认走 FTS5 索引（1–6ms）。
- `--exact`：线性扫描全部 JSONL，覆盖工具输出，2–5s；报错码/函数名/路径/commit 用这个。
- `--harness`：`claude-code` / `codex` / `opencode` / `doubao`
- `--device`：设备 id
- `--since`：时间窗
- `--limit`：默认 10，最大 50

## 索引与状态

```bash
trove index build                 # 增量构建会话索引（全量约 14s，增量 < 2s）
trove index build --force         # 忽略 hash 全量重建
trove index build --since 365d    # 只索引一年内
trove status --json               # 设备/会话/经验/索引状态
```

索引位置：`~/.trove/cache/search.sqlite`（本地缓存，可随时删除重建；不参与同步）。

## 接入

```bash
claude mcp add trove -- trove mcp
trove skill install --target both
```
