# 项目约定

本文件补充 `~/.claude/CLAUDE.md` 的通用规则，只记录 router-agent 仓库自己的要求。

## 日志规范（必须遵守）

日志是排查「消息没反应 / 配置没生效 / 服务报错」的第一入口。新增或修改功能时，**先想清楚这条链路失败时用户能不能从日志里查到原因**，再写代码。

### 格式

- 服务日志一行一个 JSON：`at`（ISO 时间）/ `level` / `message` + 业务字段，由 `src/cli/index.ts` 的 `createLogger` 统一写入 `<RA_HOME>/logs/router-agent.log`。
- `message` 用 `域:动作` 的 kebab-case，例如 `trigger:ingested`、`config:parse-failed`。常用域：`feishu` / `chats` / `trigger` / `loop` / `decision` / `chat` / `session` / `config` / `api` / `ticket` / `outbox` / `effect` / `worker` / `launch` / `input` / `report` / `progress` / `pr` / `retention` / `recover`。
- 业务字段**平铺**在同一层，不要塞 `payload` / `data` 嵌套对象；长文本用 `preview()`（`src/core/events.ts`）截断。
- 每个事件至少带一个可定位字段：`triggerId` / `ticketId` / `inputId` / `key` / `chat` / `path` / `handle`。

### 级别

| 级别 | 用途 | 例子 |
|-|-|-|
| `info` | 正常关键节点与状态变化，能串起完整链路 | 消息入库、派工、投递、上报、配置更新 |
| `warn` | 已降级的异常，流程还能继续 | 模型回复失败走了兜底、卡片降级为富文本、缓存损坏 |
| `error` | 影响主流程、需要人介入的失败 | 派工失败、API 请求异常、安全参数被覆盖 |

### 硬性要求

1. **禁止空 catch**：每个 `catch` 要么重新抛出，要么写 `warn` / `error`，并且必须带上错误原因（统一用 `errorMessage(error)`，来自 `src/infra/logger.ts`）。如果失败被有意忽略，注释里要写清为什么。
2. **关键链路必须留痕**：
   - 消息：接入、过滤（`trigger:dropped`）、去重（`trigger:duplicate`）、研判结论、回复生成与投递（`outbox:sent` / `outbox:failed`）；
   - 通信：飞书事件消费与重连、lark-cli 调用失败、卡片降级、群名目录刷新；
   - 配置：加载（创建 / 解析失败 / 旧配置迁移）、面板保存（校验 / 落盘）、策略版本变化；
   - 异常：API 请求级失败、worker 状态查询失败、PR 跟踪失败、会话读写失败、effect 执行失败。
3. **不要记录敏感信息**：API Key、token、App Secret、完整 prompt、完整用户消息、完整文件内容都不能进日志；用户消息用 `preview(text, 120~160)`，错误里的 stderr 截断到 200~300 字。
4. **不打印堆栈**：日志只写一行可读原因；调试堆栈留在终端或测试里。
5. **高频路径降噪**：轮询、重复状态、同一错误的连续重试不要每条都打；在状态变化或首次失败时打一次。同类事件用稳定字段做去重。
6. **日志失败不能影响主流程**：写日志本身要吞掉 IO 异常（`createLogger` 已处理）；`appendEventLog` 等辅助写盘也要 try/catch。
7. **模块只依赖 `Logger` 接口**：通过构造参数注入 `src/infra/logger.ts` 的 `Logger`，缺省用 `noopLogger`；不要在业务模块里直接 `console.log`、直接写文件或自己拼时间戳。
8. **新增事件同步文档**：在 `README.md` 与 `README.en.md` 的日志事件表里补上事件名、来源、关键字段与含义。
9. **失败路径要测试**：新增的 warn / error 日志，至少补一条测试断言事件名与关键字段（参考 `tests/config.test.ts`、`tests/router/agent-loop.test.ts`、`tests/router/api.test.ts`）。

### 查看与排查

```bash
ra logs                                  # 最近 50 行
ra logs --follow                         # 实时跟随
grep '"message":"trigger:' ~/.router-agent/logs/router-agent.log
```

面板「日志」页支持按 INFO / WARN / ERROR 过滤与关键字搜索；读文件实现见 `src/router/log-tail.ts`。

## 代码与提交

- 代码注释、提交信息、文档统一使用中文。
- 提交前至少通过 `pnpm typecheck` 与 `pnpm test`；交付前跑 `pnpm build`。
- 不直接连数据库做写操作；状态写入一律走 `src/core/engine.ts`。
