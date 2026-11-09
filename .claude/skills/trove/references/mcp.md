# trove MCP 工具参考

`trove mcp` 启动 stdio MCP server。所有工具只读，返回 Markdown 文本；单次响应 search ≤ 16KB、get ≤ 64KB。

## trove_whoami

输入：

```json
{ "sections": ["profile", "styles", "recent"], "full": false }
```

- `sections`：`profile` / `styles` / `recent` / `all`，默认前三项。
- `full`：包含年龄/人际关系等敏感分区，默认 `false`。

## trove_lessons_search

```json
{ "query": "飞书 编辑", "category": "experiences", "since": "90d", "limit": 5 }
```

返回：标题、路径、类型、更新时间、片段。结果不足时再调 `trove_sessions_search`。

## trove_lesson_get

```json
{ "path": "experiences/gotcha-feishu-edit-button-hit-testing.md", "section": "背景", "lines": "1-80", "full": false }
```

默认 8KB；`full=true` 上限 64KB。路径必须是 lessons 根下的相对路径。

## trove_lessons_list

```json
{ "category": "experiences", "since": "7d", "limit": 50 }
```

## trove_sessions_search

```json
{ "query": "SignatureDoesNotMatch", "exact": true, "harness": "claude-code", "limit": 5 }
```

- 自然语言：不传 `exact`，走 FTS5。
- 精确标识符：`exact=true`，线性扫描全部 JSONL（2–5s）。
- 返回会话 id、harness、设备、时间、标题、片段、分数。

## trove_session_get

```json
{ "session_id": "7d0100c4-...", "around": "SignatureDoesNotMatch", "limit": 6 }
```

默认前 20 条事件；`around` 定位到包含该文字的片段附近。单条事件文本 2KB，默认脱敏。

## trove_status

无参数。返回索引会话数/总数、是否过期、索引体积、经验数量。

## 错误

工具错误返回 `isError: true` 和可执行提示（如「运行 trove index build」）。索引缺失时会降级为线性检索，并在结果中标注 `degraded`。
