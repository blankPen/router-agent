# 排障

## 上报失败

### 退出码 2：参数错误

stderr 会指出是哪个参数。对照 `references/reply-protocol.md` 改参数。

### 退出码 1：服务端拒绝

stderr 会带服务端给的完整原因。常见的是 **422 UI 证据不足**：

```text
上报失败(422)：UI 工单缺少 PR / MR 证据：Before 标识。
```

补齐 PR / MR 描述里的 Before / After 后重新上报；
确实补不了就改报 `--state blocked`，不要反复重试 `ready`。

### 退出码 3：服务不可达

Router 服务没起来。命令已经把内容落盘到 `<RA_HOME>/workers/<ticketId>/state.json`，
Router 轮询后会自动生效，**不需要重试**。

## 命令找不到 / 被拒

Worker 的 shell 权限是白名单制，默认放行 `ra reply` / `ra report` / `ra doc` / `git` / `gh` / `glab`
等前缀。如果 `ra reply` 被拒，说明白名单里只有旧命令，让人补上即可。

## 首轮没拿到需求细节

首轮引导里同时有「授权范围（研判结论）」与「用户原始请求」。
以用户原始请求为准；两者冲突时在 `--summary` 里写清差异。

## 读不到技能文件

技能目录固定在 `<RA_HOME>/specs/worker/`。首轮引导会给出 `SKILL.md` 的绝对路径；
读不到时用 `references/` 里对应的规范说明，或直接用 `--body` 交付完整结论。

## 看日志

```bash
ra logs                                  # 最近 50 行
ra logs --follow                         # 实时跟随
grep '"message":"launch:' ~/.router-agent/logs/router-agent.log
```

