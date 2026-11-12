# 插件依赖安装 · 界面 Before / After

同一场景（配置 → 派工与服务 → 运行时插件）、同一视口（1440×1000 @2x）、同一主题（浅色）。

场景：`config.yaml` 里已声明 `runtime.plugins.demo-runtime: ra-demo-runtime`，
但 npm 包还没下载到 `<RA_HOME>/node_modules`，插件加载失败。

| 截图 | 说明 |
|-|-|
| `before.png` | 改造前：行内只有「恢复默认」，没有安装入口；用户只能自己找包名、手动 npm install |
| `after.png` | 改造后：npm 包入口多出「安装依赖」按钮，点击后把包下载到 `<RA_HOME>/node_modules`，完成后提示重启 |

截图来自真实服务 + Chromium（Playwright），不是 mock。`ra-demo-runtime` 是本地构造的
第三方运行时插件包（`kind: 'runtime'`），用于验证「包装在 `RA_HOME` 之后加载器才能解析」这条链路：
未安装时 `plugin:load-failed`，装进 `RA_HOME/node_modules` 后 `plugin:loaded`。
