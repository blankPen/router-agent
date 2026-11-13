# 代码交付

## 分支

- 工作分支：`{{workBranch}}`；在工单指定的起始分支 `{{branch}}` 之上开。
- 不要在起始分支上直接提交。

## 提交前

```bash
pnpm typecheck
pnpm test
pnpm build
```

提交前至少 `pnpm typecheck` 与 `pnpm test` 必须绿；交付前跑 `pnpm build`
（改了 `packages/*/src` 后不 build，CLI 用的还是旧产物）。

## 开 PR / MR

- GitHub：`gh pr create`
- GitLab：`glab mr create`；没有 `glab` 时用 `git push -o merge_request.create`

标题用中文，正文写清三段：

```text
## 做了什么
## 怎么验证的
## 风险
```

上报时带 `--pr-number` 与 `--pr-url`；**不要自己合并 PR / MR**，合并由人决定。
CI 失败时修到绿；修不动用 `--state blocked` 说明失败原因。

## 提交信息

代码注释、提交信息、文档统一使用中文。

## 范围

- 只改本工单授权范围内的模块。
- 需要跨范围时，用 `--state blocked --human-action "..."` 回交，等人确认。
- 修 bug 先 grep 所有调用方，在公共代码里修一次根因，不要在每个调用点各修一遍。

