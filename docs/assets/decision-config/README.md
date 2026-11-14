# 决策层（Jev）配置 · 界面 Before / After

同一场景（Web 面板「配置」页）、同一视口（1440×1000 @2x）、同一主题（浅色）。
基线：合并远端 main 后的 `ra/tk-86-llm`（`64309df`）；改动版本：同分支新增「决策层」配置分组。

| 截图 | 说明 |
|-|-|
| `before-config-page.png` | 改造前：配置页一级分组是「LLM Provider → 运行时 → 渠道 → 项目 → 消息准入 → 其他设置」，没有决策层入口 |
| `before-search-decision.png` | 改造前同场景：在「筛选配置项」搜「决策」→ 没有匹配的配置项 |
| `after-config-page.png` | 改造后：导航出现「决策层」分组，页面说明同步为「LLM Provider → 决策层 → 运行时 → …」 |
| `after-decision-form.png` | 改造后：「决策层 → 决策模型（Jev）」表单：启用开关、Provider、模型名、API Key、Base URL |

截图取自本地真实运行的服务（`node dist/cli/main.js serve`，临时 `RA_HOME`），配置内容是占位值，未包含任何真实密钥。
