# 自定义运行时 id 自动识别 · 界面 Before / After

同一场景（初始化页「2. 选择运行时」→「添加运行时」弹窗，包名填 `@acme/runtime-demo`）、
同一视口（1440×900）、同一主题（浅色）。

| 截图 | 版本 | 说明 |
|-|-|-|
| `before-add-runtime.png` | `main` @ `02c140c` | 需要手填 id 与 npm 包名 |
| `after-add-runtime.png` | `ra/tk-15-runtime-id` | 只填入口，弹窗自动识别并展示 `runtime id = demo` |

截图来自真实启动的 Web 面板 + Chromium（Playwright），不是 mock。
