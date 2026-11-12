# 插件式扩展 · 界面 Before / After

同一场景（配置 → 派工与服务）、同一视口（1440×1000 @2x）、同一主题（浅色）。

| 截图 | 说明 |
|-|-|
| `before-delivery.png` | 改造前：只有内置运行时 + ACP Agent，没有插件状态与自定义插件入口 |
| `after-delivery.png` | 改造后：已安装的用户插件 `example` 出现在「自定义插件」分组，可直接选用 |
| `after-plugin-settings.png` | 「派工与服务」底部的插件配置区：逐个显示加载状态、包名与实际尝试的入口 |
| `after-selected-plugin.png` | 把自定义插件选为默认运行时后，左下角状态显示 `运行时 example` |

After 截图中的 `example` 是用 `templates/runtime-plugin` 复制、改名、发布到本地
registry 后装进 `RA_HOME` 的真实插件，不是 mock 数据。
