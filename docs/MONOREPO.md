# Monorepo 与可插拔 runtime / channel

仓库是 pnpm workspace。`router-agent` 是宿主应用；`@router-agent/*` 是独立发布的
SDK 与内置插件包。用户扩展的 runtime / channel 也按同一套协议发布成独立 npm 包，
在配置页填写包名或本地路径即可加载，不需要改宿主代码。

## 包划分

```text
packages/core              领域内核：Ticket / Mandate / Assignment / Stage / Policy 与共享类型
packages/infra             基础设施：Logger、CommandRunner、对话模型、图片识别、插件加载器
packages/runtime           Runtime SDK：WorkerRuntime 端口、RuntimeRegistry、插件协议
packages/channel           Channel SDK：ChannelAdapter 端口、ChannelRegistry、入站管线、插件协议
packages/runtime-orca        内置插件：Orca
packages/runtime-claude-code 内置插件：Claude Code
packages/runtime-codex       内置插件：Codex App
packages/runtime-herdr       内置插件：Herdr
packages/runtime-t3code      内置插件：T3 Code
packages/runtime-acp         内置插件：ACP
packages/channel-feishu      内置插件：飞书
src/                       宿主应用：Engine/Store、Router、API/Web、CLI、配置与装配
templates/runtime-plugin   自定义 runtime 包模板
templates/channel-plugin   自定义 channel 包模板
```

依赖方向是单向的：

```text
core  ←  infra  ←  runtime / channel  ←  src/
```

- `packages/*` 不能 import `src/`（有测试兜底：`tests/architecture/packages.test.ts`）；
- `runtime` 与 `channel` 互不依赖，都只向下依赖 `core` / `infra`；
- 适配器需要的配置形状放在 `packages/core/src/config.ts`（`RuntimeConfigView` / `ChannelConfigView`），
  宿主 `AppConfig` 结构上兼容，适配器不再直接 import 宿主配置。

## 包别名与依赖

| 别名 | 指向 |
|-|-|
| `#core/*` | `packages/core/src/*` |
| `#infra/*` | `packages/infra/src/*` |
| `#runtime/*` | `packages/runtime/src/*` |
| `#channel/*` | `packages/channel/src/*` |
| `@router-agent/core` / `@router-agent/infra` / `@router-agent/runtime` / `@router-agent/channel` | workspace 包（`node_modules` 软链到 `packages/*`） |

三处解析保持一致：

- **tsc**：根 `tsconfig.json` 的 `paths`（含 `@router-agent/*` 深路径）；
- **运行时**：根 `package.json` 依赖 `@router-agent/*`（`link-workspace-packages=true`），包入口指向各自 `dist/`；
- **宿主私有别名**：根 `package.json` 的 `imports` 只保留 `#core/*` / `#infra/*` / `#runtime/*` / `#channel/*`（`imports` 只能映射 `#` 开头的说明符）；
- **vitest / esbuild**：`vitest.config.ts` 的 alias 与 `scripts/build-web.mjs` 的 `tsconfig`。

因为 `#*` 别名指向 `dist/`，**改完宿主源码必须 `pnpm build`** 才会被 CLI 用上；
包源码由 `node_modules` 软链解析到 `packages/*`，其入口也指向各自 `dist/`，
所以改包后同样要先 `pnpm build`。测试直接跑源码，不受影响。

## 插件加载协议

配置里每个插件条目可以是包名、本地路径，或对象：

```yaml
runtime:
  default: demo
  plugins:
    demo: "@acme/runtime-demo"
    local-runtime:
      path: ./plugins/local-runtime
      entry: dist/index.js
channels:
  my-channel: "@acme/router-channel"
```

- 目录型入口优先用 `entry`，其次是 `package.json` 的 `exports["."]` / `module` / `main`，
  最后回退 `index.js` / `index.mjs` / `index.cjs`；
- 裸包名先按宿主模块解析，装在 `<RA_HOME>/node_modules` 的 ESM-only 包（`exports` 只有
  `import` 条件）会额外按目录回退解析，用户不必为 CI 之外的安装方式再配路径；
- `enabled: false` 可临时禁用某个插件；
- 加载失败只记录 `plugin:load-failed` / `plugin:create-failed` 并继续启动其它插件，
  面板与 `GET /api/config` 的 `plugins` 字段会显示失败原因与实际尝试的 `specifier`；
- 一个插件包可以实现 `createAll()` 一次注册多个实例（ACP 就按 Agent 目录注册多个 runtime）。

### runtime 插件

```ts
import type { RuntimePlugin } from '@router-agent/runtime'

const plugin: RuntimePlugin = {
  kind: 'runtime',
  meta: { id: 'my-runtime', name: 'My Runtime', label: 'my-runtime · ...', hint: '...' },
  options: { runtimeId: 'my-runtime', fields: [{ key: 'command', label: '命令', kind: 'text' }] },
  create(ctx) { /* 返回 WorkerRuntime */ },
}

export default plugin
```

`create(ctx)` 拿到的是中立上下文：`home`、`workersDir`、`config`（只含 `RuntimeConfigView`）、
`env`、`logger` 与可选的命令运行器。插件只依赖 `@router-agent/runtime` / `@router-agent/core` /
`@router-agent/infra`，不要 import 宿主 `src/`。

### channel 插件

```ts
import type { ChannelPlugin } from '@router-agent/channel'

const plugin: ChannelPlugin = {
  kind: 'channel',
  meta: { id: 'my-channel', name: 'My Channel', hint: '...' },
  create(ctx) { /* 返回 ChannelAdapter */ },
}

export default plugin
```

`ChannelAdapter` 负责 `normalize(raw) -> Trigger` 与 `send(message)`；需要消费事件的通道实现
`start(sink)`。宿主启动时会遍历所有已加载通道并调用 `start()`，出站按 `channelKind`
（即通道实例 id）路由。

模板见 `templates/runtime-plugin` 与 `templates/channel-plugin`；复制后改包名，
`pnpm build` 即可在配置页填写本地路径联调，发布到 npm 后填包名即可。

面板截图（改造前后）见 `docs/assets/plugin-before-after/README.md`。

## 新增一个内置 runtime / channel

1. 复制对应模板到 `packages/runtime-<id>` / `packages/channel-<id>`；
2. 在 `packages/*/package.json` 声明对 SDK 的依赖，入口指向 `./dist/index.js`，并导出 `types`；
3. 在 `scripts/publish-packages.mjs` 的 `PUBLISH_ORDER` 里按依赖顺序补一行；
4. 内置 runtime / channel 的默认包名分别登记在
   `packages/runtime/src/plugins/loader.ts` 的 `DEFAULT_RUNTIME_PLUGINS` 与
   `packages/channel/src/plugins/loader.ts` 的 `DEFAULT_CHANNEL_PLUGINS`；
5. 在根 `package.json` 加同版本依赖，保证装根包时能解析到内置插件。

## 构建与发布

```bash
pnpm typecheck    # tsc --noEmit（含 packages/*）
pnpm test         # vitest（tests/ 与 packages/*/tests/）
pnpm build        # tsc（含 .d.ts）→ esbuild 面板与 Markdown 资产 → 拍平 dist/src/* → 生成 packages/*/dist
```

`pnpm build` 先用 `scripts/flatten-dist.mjs` 把 tsc 产物从 `dist/src/*` 拍平回 `dist/*`，
再由 `scripts/build-packages.mjs` 把每个包的编译产物复制到 `packages/<pkg>/dist`，
并改写 `#core/*` 等宿主私有别名为 `@router-agent/*`，使插件包可以独立发布。
发版判断（`scripts/release-plan.mjs`）把 `packages/<name>/src/**` 视为产物改动，
包内 `tests/`、`package.json`、`pnpm-workspace.yaml` 不触发自动发版。
