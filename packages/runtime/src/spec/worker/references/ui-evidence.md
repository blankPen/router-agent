# UI 改动：Before / After 证据

只要改动会影响用户看到或操作的界面（页面、组件、样式、交互、布局），
PR / MR 描述里必须**同时**给出 Before 和 After 两组视觉证据。

## 硬要求

- **只有 After 不算完整交付**；不要用设计稿、手工 mockup 或改动后的页面冒充 Before。
- 两组截图用同一场景、同一视口（窗口尺寸）、同一主题（明 / 暗）和同一 UI 状态。
- 必须是真实运行中的页面截图；白屏、加载中骨架、404 / 500 都不算证据。
- 不要暴露飞书私密内容、真实用户数据或任何凭据。
- 后续改动让界面对不上时重新截一组，不要沿用过期截图。

## 截图方法

1. 优先用仓库自带的启动、预览与截图脚本（看 README、`package.json`、`AGENTS.md`）。
2. 没有现成脚本时，启动本地开发 / 预览服务，用 Playwright 截图：

   ```bash
   npx playwright install chromium
   npx playwright screenshot --viewport-size=1440,900 --wait-for-timeout=2000 http://localhost:3000/page before.png
   ```

3. **动手前先在未改动状态（起始分支）截 Before**，改完后在同一环境截 After；
   中途切换过分支就重启 dev server，确认截到的是对应版本的代码。

## 放进 PR 描述

- 把截图提交到分支后用仓库内图片链接引用，或用项目已有的素材托管 / 上传接口。
- 不要只写本机文件路径，也不要把私人图床链接写进公开仓库。

## 门禁

Router 可能开启 UI 证据门禁（`worker.evidence.ui`）：

- `enforce` 档下缺证据的 `--state ready` 会返回 422 并告诉你缺什么；
  **补不了就改用 `--state blocked`，不要反复重试 `ready`**。
- `warn` 档只记日志，不会拦。

拿不到真实基线时，在 PR / MR 描述和回复里如实说明缺什么、为什么缺，
本轮用 `blocked` 或 `progress` 上报，**不要报 `ready`**。

## 回复里也能带图

```bash
ra reply --ticket {{ticketId}} --state ready \
  --summary "UI 已改完，PR 已开" \
  --pr 42 --pr-url "https://github.com/o/r/pull/42" \
  --image before=./before.png --image after=./after.png \
  --body "改动说明见 PR。"
```

