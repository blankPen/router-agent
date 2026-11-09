# HTTP API

Router 在 `server.port`（默认 3083）上提供本地 HTTP API，供 Web 面板、CLI 与 `ra report` 使用。

| 方法 | 路径 | 说明 |
|-|-|-|
| GET | `/api/status` | 服务与工单概览 |
| GET | `/api/tickets?stage=&limit=` | 工单列表 |
| GET | `/api/tickets/:id` | 工单详情 |
| POST | `/api/tickets/:id/input` | 投递 follow-up |
| POST | `/api/tickets/:id/stop` | 停止工单 |
| POST | `/api/tickets/:id/assignment` | 手工绑定 Assignment |
| GET | `/api/workspaces` | 工单页「清理工作区」：按运行时分组列出仍存在的工单工作区 |
| POST | `/api/workspaces/cleanup` | 批量清理工作区（`{ ticketIds }` 按工单；或 `{ runtimeId }` 清理该运行时全部可清理项；脏目录跳过并回报原因） |
| POST | `/api/reports` | Worker 上报状态与回复（`ra report` 的入口） |
| GET / PUT | `/api/policy` | 读写策略（保存后落盘） |
| GET / PUT | `/api/config` | 配置面板：读安全快照 / 按点路径提交补丁（白名单校验 + 落盘） |
| POST | `/api/restart` | 热重启 daemon：先返回 202，再释放端口并拉起新进程（页面不刷新） |
| GET | `/api/sources/feishu/chats` | 飞书来源配置 |
| GET | `/api/logs?cursor=&limit=` | 面板日志页：不带 `cursor` 回看尾部若干行，带上后只返回新增行 |
| POST | `/api/projects/pick-directory` | 打开系统目录选择框（添加本地项目） |
| POST | `/api/projects/inspect` | 识别目录是否为 Git 仓库、当前分支与 origin |
| POST | `/api/projects/register` | 本地项目登记（Orca 运行时执行 `orca repo add`） |
| POST | `/api/projects/clone` | Git 项目：clone 到 `<RA_HOME>/repos` 并按需登记 Orca |

`/api/reports` 的请求体与状态语义见 [ARCHITECTURE.md · 上报协议](ARCHITECTURE.md#上报协议)；配置补丁的字段白名单见 [CONFIGURATION.md](CONFIGURATION.md)。
