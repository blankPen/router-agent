# 发布 npm 包

包名 `router-agent`，CLI 命令 `ra`。发布由 `.github/workflows/publish-npm.yml` 完成，本地不直接 `npm publish`。

## 一次性准备

1. **确认包名可用**：`npm view router-agent version` 返回 404 即未占用（2026-11-06 已验证）。
2. **创建 npm Token**：npmjs.com → Access Tokens → Generate New Token → **Granular Access Token**
   - Permissions: **`Read and write (publish and stage)`**
     （npm 有三个档位；选成 `stage only` 不会报错，而是把版本写进暂存区，流水线照样绿，但包不会上线，npm 上只显示占位版本 `0.0.0-stage`）
   - Packages: 选择 `All packages`（首次发布时该包还不存在，只有 All 才能在创建时生效）
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

1. **生成发布计划**（`scripts/release-plan.mjs`）：读取 `package.json` 的 `name`/`version`，
   结合触发方式、推送前的版本、本次改动的文件与提交信息，决定「发不发、发哪个版本」：
   - tag / 手动触发：按当前版本发布，npm 上已有则跳过（tag 触发时会先校验 tag 与版本一致）；
   - main 推送：命中跳过条件就跳过，否则自动升 patch（会跳过 npm 上已占用的版本）；
2. 校验 `NPM_TOKEN` 是否存在；
3. `pnpm install --frozen-lockfile`；
4. 自动升版时把 `package.json` 版本改成计划里的版本；
5. `pnpm check`（类型检查 + 全量测试）；
6. `pnpm build`（tsc + esbuild，产物在 `dist/`）；
7. `npm publish --provenance`，带构建来源证明（`id-token: write`）；
8. 发布后回查版本是否真的可从 npm 查询到（防止只有 stage 权限时静默进入暂存区）；
9. 自动升版时把版本号提交回 `main`，让仓库与 npm 保持一致。

## 自动升版与分支保护

「回写版本号到 main」用仓库自带的 `GITHUB_TOKEN` 推送（工作流已声明 `contents: write`）：

- `main` 未要求必须走 PR 时可以直接回写；
- 若分支保护禁止 Actions 直接推送，工作流会在发布成功后打印 warning 并继续（不会失败）。
  npm 上的版本已经发布，只是仓库里的 `package.json` 暂时落后；下一次合并时工作流会以
  npm 上最新版本为基准继续升 patch，不会重复发布，也不会卡住；
- 版本号提交带 `[skip release]`，即使用 PAT 推送触发了下一次工作流，也会被跳过。

判断规则与边界情况见 `scripts/release-plan.mjs`，单测见 `tests/scripts/release-plan.test.ts`。

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

工作流末尾的「校验发布结果」会回查版本是否可查询，遇到这种情况会直接失败并提示原因，不再静默通过。
长期方案是把 token 权限改为 `Read and write (publish and stage)`，或改用 Trusted Publishing（无需 token，但对已存在的包才能配置）。

## 常见失败排查

| 报错 | 原因 | 处理 |
| --- | --- | --- |
| `E401 Unauthorized` | `NPM_TOKEN` 缺失、过期或无效 | 重新生成 token 并更新 Secret |
| `E403 ... two-factor authentication` | token 未勾选 Bypass 2FA | 重新生成 granular token |
| `E403 ... not allowed to publish` | token 权限不足或 Packages 未选 All | 调整 token 权限 |
| `E409 ... cannot publish over existing version` | 同版本已发布 | 升版本号后重新发版；工作流正常情况下会提前跳过 |
| 流水线成功但 npm 上只有 `0.0.0-stage` | token 只有 `stage only` 权限，版本进了暂存区 | 改 token 权限，或在 Staged Packages 中 Approve |
| `tag vX 与 package.json 版本不一致` | tag 与版本不同步 | `pnpm version` 重新打 tag 再推 |
| 流水线提示「版本号回写 main 失败」 | main 分支保护禁止 Actions 直接推送 | 允许 Actions 推送，或忽略该提示：npm 已发布，下一次合集会以 npm 上最新版本为基准继续升 patch |
| provenance 相关报错 | 缺少 `id-token: write` 或仓库/runner 不满足要求 | 检查工作流权限与仓库可见性 |
