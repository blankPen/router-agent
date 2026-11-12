# Monorepo 与可插拔 runtime / channel

仓库是 pnpm workspace：应用（`router-agent` 包）与三个可插拔适配器包放在同一个仓里，
但**仍然只发布一个 npm 包** `router-agent`（`files` 只含 `bin/` 与 `dist/`）。
适配器包的源码会被 tsc 一起编进 `dist/packages/`，`dist/cli/main.js` 按原样对外。

## 包划分

```text
packages/core       领域内核：Ticket / Mandate / Assignment / Stage / Policy 与共享类型
packages/infra      基础设施：Logger、CommandRunner、对话模型、图片识别
packages/runtime    Worker 运行时：WorkerRuntime 端口、RuntimeRegistry 与各 adapter
packages/channel    消息通道：ChannelAdapter 端口、ChannelRegistry 与飞书 adapter
src/                宿主应用：Engine/Store、Router、API/Web、CLI、配置与装配
```

依赖方向是单向的：

```text
core  ←  infra  ←  runtime / channel  ←  src/
```

- `packages/*` 不能 import `src/`（有测试兜底：`tests/architecture/packages.test.ts`）；
- `runtime` 与 `channel` 互不依赖，都只向下依赖 `core` / `infra`；
- 适配器需要的配置形状放在 `packages/core/src/config.ts`（`RuntimeConfigView` / `ChannelConfigView`），
  宿主 `AppConfig` 结构上兼容，适配器不再直接 import 宿主配置。

## 包别名

| 别名 | 指向 |
|-|-|
| `#core/*` | `packages/core/src/*` |
| `#infra/*` | `packages/infra/src/*` |
| `#runtime/*` | `packages/runtime/src/*` |
| `#channel/*` | `packages/channel/src/*` |

三处解析保持一致：

- **tsc**：根 `tsconfig.json` 的 `paths`；
- **运行时**：根 `package.json` 的 `imports` 指向 `./dist/packages/<pkg>/src/*`；
- **vitest / esbuild**：`vitest.config.ts` 的 alias 与 `scripts/build-web.mjs` 的 `tsconfig`。

因为 `imports` 指向 `dist/`，**改完包源码必须 `pnpm build`** 才会被 CLI 用上；测试直接跑源码，不受影响。

## 新增一个 runtime

1. 在 `packages/runtime/src/runtimes/<id>/` 实现 `WorkerRuntime`（见 `packages/runtime/src/port.ts`）；
2. 在 `packages/runtime/src/runtimes/catalog.ts` 加一条元数据（Web 卡片与配置校验共用）；
3. 需要面板可配的话，在 `packages/runtime/src/runtimes/options.ts` 注册选项声明；
4. 在 `packages/runtime/src/registry.ts` 的 `createRuntimes` 里装配；
5. 适配器只依赖 `#core` / `#infra` / 同包内相对路径，不要 import `src/`。

## 新增一个 channel

1. 在 `packages/channel/src/<kind>/` 实现 `ChannelAdapter`（见 `packages/channel/src/port.ts`）；
2. 在装配层（`src/cli/index.ts`）注册到 `ChannelRegistry`；
3. 入站管线是 `ChannelIngress`，只要求 `IngressSink`（`ingest(trigger): boolean`）与 `AckStore`，不依赖宿主 Engine / Store 的具体类型；
4. 通道特有配置用 `#core/config.js` 里的中立视图，或包内自己的 `config.ts`。

## 构建与发布

```bash
pnpm typecheck    # tsc --noEmit（含 packages/*）
pnpm test         # vitest（tests/ 与 packages/*/tests/）
pnpm build        # tsc → esbuild 面板与 Markdown 资产 → 拍平 dist/src/* 到 dist/*
```

`pnpm build` 最后一步 `scripts/flatten-dist.mjs` 把 tsc 产物从 `dist/src/*` 拍平回 `dist/*`，
保持 npm 包对外结构与相对路径（`dist/cli/main.js`、`dist/web`、`dist/update`）不变。
发版判断（`scripts/release-plan.mjs`）把 `packages/<name>/src/**` 视为产物改动，
包内 `tests/`、`package.json`、`pnpm-workspace.yaml` 不触发自动发版。
