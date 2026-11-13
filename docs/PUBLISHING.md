# 发布 npm 包

包名 `router-agent`，CLI 命令 `ra`。发布由 `.github/workflows/publish-npm.yml` 完成，本地不直接 `npm publish`。

## 一次性准备

1. **确认包名可用**：`npm view router-agent version` 返回 404 即未占用（2026-11-06 已验证）。
   现在发布的不止根包：`@router-agent/core` / `infra` / `runtime` / `channel` 与内置
   runtime / channel 插件也会一起发布，见「发布内容」。
2. **创建 npm Token**：npmjs.com → Access Tokens → Generate New Token → **Granular Access Token**
   - Permissions: **`Read and write (publish and stage)`**
     （npm 有三个档位；选成 `stage only` 不会报错，而是把版本写进暂存区，流水线照样绿，但包不会上线，npm 上只显示占位版本 `0.0.0-stage`）
   - Packages: 选择 `All packages`。必须同时覆盖**已存在的** `router-agent` 和**首次发布的**
     `@router-agent/*` 作用域；只勾选其中一类，另一类会返回 E404。
   - **勾选 Bypass two-factor authentication**（CI 无交互，不勾选会 403）
3. **写入仓库 Secret**：GitHub 仓库 → Settings → Secrets and variables → Actions → New repository secret
   - Name: `NPM_TOKEN`
   - Value: 上一步生成的 token
   - 配置后确认：`gh secret list --repo blankPen/router-agent` 应能看到 `NPM_TOKEN`（注意认准仓库 `blankPen/router-agent`，配到 fork 或其他仓库不会生效）

## 发版流程

### A. 合并到 main（推荐，自动升 patch）

日常需求 PR 合并进 `main` 后，工作流会自动判断并发布，**不需要再手改版本号**：

1. 本次推送没有改 `package.json` 的 `version`，且改动里包含会进入 npm 包的文件
   （`src/`、`bin/`、`scripts/`、依赖与构建配置等）→ 自动升 patch；
2. 如果升出来的版本在 npm 上已被占用，继续往上找第一个未占用的 patch；
3. 跑完整校验（`pnpm check`）、构建并发布；
4. 发布成功后把版本号提交回 `main`（提交信息带 `[skip release]`，避免再触发一次升版）。

以下情况会跳过自动发版，不产生新版本：

- 本次改动只涉及 `docs/`、`tests/`、`.github/`、`*.md`、`LICENSE` 等不会进包的文件；
- 提交信息里带 `[skip release]`；
- 本次推送已经手动改过 `package.json` 的 `version`（见 B，按该版本发布）；
- 该版本在 npm 上已存在。

> 为什么用 GitHub Actions 而不是本地 Git hook：PR 在 GitHub 上合并不会执行本地 hooks，
> 把「合并后升版」放在 `push(main)` 工作流里才能覆盖网页合并、CLI 合并与本地推送。

**B. 发 minor / major（手动指定版本）**

在发版 PR 里改好版本号（不要打 tag），合并后工作流会按该版本发布：

```bash
pnpm version minor --no-git-tag-version   # 或 major / 指定的 patch
pnpm check                                # 本地先跑一遍
git add -A && git commit -m "chore: 发布 v$(node -p "require('./package.json').version")"
git push origin HEAD                      # 发起 PR
```

工作流只识别「本次推送是否改了 `package.json` 的 `version`」；如果该版本已存在于 npm，
会跳过发布。同一版本只会发布一次，工作流可安全重跑。

**C. 打 tag（兼容原有方式）**

```bash
pnpm version patch              # 会同时改 package.json 并打 vX.Y.Z tag
git push --follow-tags          # 推提交 + tag
```

tag 必须与 `package.json` 的 `version` 一致，否则工作流会在发布前报错。
main 推送和 tag 推送同时触发时会串行执行，后一个看到版本已存在会自动跳过。

**D. 手动触发**

Actions → 发布 npm 包 → Run workflow。发布的是所选分支 `package.json` 里的版本。

## 工作流做了什么

0. 仓库是 pnpm workspace，会按依赖顺序发布 11 个包：
   1. SDK：`@router-agent/core` → `infra` → `runtime` → `channel`
   2. 内置插件：`runtime-codex` / `runtime-herdr` / `runtime-claude-code` / `runtime-orca` / `runtime-t3code` / `runtime-acp` / `channel-feishu`
   3. 根包 `router-agent` 最后发

   顺序由 `scripts/publish-packages.mjs` 的 `PUBLISH_ORDER` 决定。根包的 `pnpm build` 会把
   `packages/*/src` 编进 `dist/packages/`，再把 `dist/src/*` 拍平回 `dist/*`，所以根包对外结构不变；
   同时 `scripts/build-packages.mjs` 为每个包生成独立的 `packages/<name>/dist`（入口 `dist/index.js`
   + `dist/index.d.ts`），插件包才能单独被用户安装。**改了 `packages/*/src` 后必须 `pnpm build`**，
   否则 CLI 与独立包用的还是旧产物。
1. **生成发布计划**（`scripts/release-plan.mjs`）：读取 `package.json` 的 `name`/`version`，
   结合触发方式、推送前的版本、本次改动的文件与提交信息，决定「发不发、发哪个版本」：
   - tag / 手动触发：按当前版本发布，npm 上已有则跳过（tag 触发时会先校验 tag 与版本一致）；
   - main 推送：命中跳过条件就跳过，否则自动升 patch（会跳过 npm 上已占用的版本）；
2. 校验 `NPM_TOKEN` 是否存在；
3. `pnpm install --frozen-lockfile`；
4. 自动升版时把 `package.json` 版本改成计划里的版本，并用 `--sync` 把所有 `@router-agent/*` 的版本与依赖同步到同一版本；
5. `node scripts/publish-packages.mjs --check-publisher`：用 `npm whoami` + `npm view router-agent maintainers --json`
   确认 token 用户是根包维护者。无权限时 npm 对已存在的包返回 **E404（伪装成不存在）**，不是 E403；
6. `pnpm check`（类型检查 + 全量测试）；
7. `pnpm build`（tsc + esbuild + 各包独立产物）；
8. `node scripts/publish-packages.mjs --check-versions`：10 个包的目标版本必须都未占用，
   避免「插件已发、根包 E404」的半发布状态；
9. `node scripts/publish-packages.mjs` 按顺序发布 SDK / 插件，最后 `npm publish --provenance --json`
   发布根包；任一包失败立即中止，并打印失败包名与 npm 原始输出末 10 行。
10. 依据 `npm publish` 的退出码与 JSON 输出判定发布是否成功（`scripts/publish-result.mjs`），
   判定结果写进 step outputs 传给后续步骤，不再回查 npm registry；
11. 自动升版时把版本号提交回 `main`，让仓库与 npm 保持一致。

### 怎么判定发布成功

判定完全依据 `npm publish` 自己的返回结果，不再轮询 `npm view`：

- **退出码非 0**：发布失败。优先从 JSON 输出里的 `error.code` / `error.summary` 取错误原因，
  取不到就退回 stderr 末尾几行；
- **退出码为 0**：从 JSON 输出里取出包名与版本，和 `package.json` 对比，一致才算成功；
- **暂存发布（staged）**：npm 11 会在输出里带 `stageId`，并在 stderr 打印 `has been staged`。
  命中即判为失败——这种 token 没有真正把包发到 npm，用户装不到。

不同 npm 版本的 JSON 外层结构不同（npm 10 是发布结果对象本身，npm 11 多包一层包名），
`scripts/publish-result.mjs` 两种都认。单测见 `tests/scripts/publish-result.test.ts`。

## 自动升版与分支保护

「回写版本号到 main」用仓库自带的 `GITHUB_TOKEN` 推送（工作流已声明 `contents: write`）：

- `main` 未要求必须走 PR 时可以直接回写；
- 若分支保护禁止 Actions 直接推送，工作流会在发布成功后打印 warning 并继续（不会失败）。
  npm 上的版本已经发布，只是仓库里的 `package.json` 暂时落后；下一次合并时工作流会以
  npm 上最新版本为基准继续升 patch，不会重复发布，也不会卡住；
- 版本号提交带 `[skip release]`，即使用 PAT 推送触发了下一次工作流，也会被跳过。

判断规则与边界情况见 `scripts/release-plan.mjs`，单测见 `tests/scripts/release-plan.test.ts`。

### 版本号会不会跳号？

不会主动跳号。只有 `npm view` 确认已存在于 npm 的版本才会被跳过；每次合并最多发布一个新版本。

- 发布失败（版本没有真正发出去）时，下一次合并会先补发当前版本，不会留下「占了号却没发布」的空洞；
- 版本号写回 main 失败时，仓库里的版本号暂时落后，但下一次合并会以 npm 上最新版本为基准继续升 patch，
  不会重复发布，也不会跳号。

手动发 minor / major 时（例如 v0.3.9 → v0.4.0），中间的 patch 不会补发，这是 semver 的正常行为。

## 发布内容

`package.json` 的 `files` 白名单只包含 `bin/` 与 `dist/`，再叠加 npm 强制包含的 `package.json` / `README.md`。
仓库里被跟踪的 `dist_副本/`、`src/`、`tests/`、`docs/` 都不会进包。

注意：`dist/` 在 `.gitignore` 中、不提交，由 CI 现场构建后再发布；本地执行
`npm publish --dry-run` 前必须先 `pnpm build`。

## 安装与升级

```bash
npm i -g router-agent   # 或 pnpm add -g router-agent
ra -v
```

`ra -v` 的版本号在运行时读取 `package.json`，不会与 npm 上的版本漂移。

## 首次发布的待办与风险

- **LICENSE**：已采用 MIT，见根目录 `LICENSE` 与 `package.json` 的 `license` 字段；如需更换版权方，改 `LICENSE` 首行即可。
- **平台限制**：README 已注明第一版只支持 macOS（Orca 依赖），npm 包本身可以安装在 Linux/Windows，但运行时功能受限。
- **provenance**：要求仓库公开且工作流在 GitHub 托管 runner 上运行，当前仓库为 public，满足条件。

## 暂存发布（staged publishing）

如果 `NPM_TOKEN` 只有 `stage only` 权限，`npm publish` 不会报错，而是把版本写进暂存区：

- npm 上只能看到占位版本 `0.0.0-stage`，`npm view router-agent@实际版本` 返回 404，用户装不到；
- 需要维护者在 https://www.npmjs.com/package/router-agent → **Staged Packages** 标签页点 **Approve**（需要 2FA），版本才真正公开；
- 或使用 npm 11+ 的 CLI：`npx npm@11 stage list router-agent` 查看暂存版本，`npx npm@11 stage approve <stage-id>` 批准。

工作流的「发布到 npm」步骤会依据 `npm publish` 的输出识别暂存发布，遇到这种情况会直接失败并提示原因，不再静默通过。
长期方案是把 token 权限改为 `Read and write (publish and stage)`，或改用 Trusted Publishing（无需 token，但对已存在的包才能配置）。

## 常见失败排查

| 报错 | 原因 | 处理 |
| --- | --- | --- |
| `E401 Unauthorized` | `NPM_TOKEN` 缺失、过期或无效 | 重新生成 token 并更新 Secret |
| `E403 ... two-factor authentication` | token 未勾选 Bypass 2FA | 重新生成 granular token |
| `E403 ... not allowed to publish` | token 权限不足或 Packages 未选 All | 调整 token 权限 |
| `E409 ... cannot publish over existing version` | 同版本已发布 | 升版本号后重新发版；工作流正常情况下会提前跳过 |
| 流水线报「只写进了暂存区」 | token 只有 `stage only` 权限，版本进了暂存区 | 改 token 权限，或在 Staged Packages 中 Approve |
| `tag vX 与 package.json 版本不一致` | tag 与版本不同步 | `pnpm version` 重新打 tag 再推 |
| 流水线提示「版本号回写 main 失败」 | main 分支保护禁止 Actions 直接推送 | 允许 Actions 推送，或忽略该提示：npm 已发布，下一次合集会以 npm 上最新版本为基准继续升 patch |
| provenance 相关报错 | 缺少 `id-token: write` 或仓库/runner 不满足要求 | 检查工作流权限与仓库可见性 |
