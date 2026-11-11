<div align="center">

<img src="docs/assets/router-agent-logo.svg" width="112" alt="router-agent logo">

# router-agent

### Say it in Feishu, get it done in your coding agent, close the loop in a PR.

**Feishu message → resident Router triage → a coding agent in its own worktree → PR tracking back to the thread.**<br>
Admission, ticketing, dispatch, follow-ups, progress sync and closure are automatic,<br>
and every ticket gets its own branch, terminal and context. Works with Orca, Claude Code and any ACP agent.

[![Stars](https://img.shields.io/github/stars/blankPen/router-agent?style=flat&color=111111)](https://github.com/blankPen/router-agent/stargazers)
[![npm](https://img.shields.io/npm/v/router-agent?color=cb3837&logo=npm)](https://www.npmjs.com/package/router-agent)
![Node](https://img.shields.io/badge/node-%E2%89%A522.19-339933?logo=node.js&logoColor=white)
![macOS](https://img.shields.io/badge/macOS-000000?logo=apple&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

[Quick start](#quick-start) &nbsp;·&nbsp; [How it works](#how-it-works) &nbsp;·&nbsp; [Core mechanics](#core-mechanics) &nbsp;·&nbsp; [Configuration](#configuration) &nbsp;·&nbsp; [Commands](#commands) &nbsp;·&nbsp; [Documentation](#documentation)

[简体中文](README.md) · **English**

</div>

<br>

## Is it for you?

If your day is a constant shuffle between repositories — drop a request in a chat, wait for someone to create a branch, open a terminal, get it running, then report back — that loop should belong to a machine.

router-agent (`ra`) is a resident two-layer agent system: **the Router only triages and dispatches; the Worker only works inside an isolated worktree**. It doesn't write code for you. It turns "who, which project, which base branch, what to do" into a ticket with a clear scope and context, then hands it to Orca, Claude Code or any ACP agent running in its own worktree.

- **Many repositories, many chats**: projects and chat bindings live in one config, and everything is confirmed before dispatch.
- **An auditable scope**: every message passes a deterministic gate, then Pi triage; accept, ignore, ask-back and unavailable are all recorded decisions.
- **No terminal babysitting**: the Worker reports with `ra report`, the Router merges progress back into the original thread, and a merged or closed PR closes the ticket.
- **Tickets don't collide**: one ticket, one worktree, one branch, one agent terminal.

It is built for everyday "message in, code out" collaboration. If you only need a one-off edit, opening your usual coding agent directly is faster.

It is a **clean rewrite** of dsh-superagent, with no dependency on the prototype's tmux / DSE profile.

## Quick start

**Prerequisites**

| Dependency | Notes |
|-|-|
| Node.js | `>= 22.19.0` (bundles npm; uses the built-in `node:sqlite`; pinned to 22.19.0 via `.nvmrc`) |
| Coding agent | Pick one: Orca (the `orca` runtime, provides worktrees and terminals), Claude Code (the `claude-code` / `acp-claude` runtimes), Codex (the `codex-app` runtime, preferring the CLI bundled with the Codex app), or another ACP agent (Codex / Gemini / OpenCode and friends) |
| lark-cli | Feishu event consumption and messaging; install it and make sure it is on `PATH` (`ra doctor` checks it); needs a Feishu custom app |
| gh / glab (optional) | PR / MR state tracking: `gh` for GitHub, `glab` for GitLab; log in to the matching platform first. Not needed if you don't track PRs / MRs |
| pnpm | Only needed to run from source or contribute (see the end of this section) |

**1 · Install**

```bash
npm install -g router-agent   # install globally from npm, then use `ra` directly
ra --help                     # verify the command is available
```

Upgrading is one command: `ra update` checks npm for the latest version, runs the global install, and restarts the running service automatically. Use `ra update --check` to only check. It is equivalent to `npm install -g router-agent@latest` followed by `ra stop && ra start`. When the web panel's sidebar notices a new version it shows an "Update and restart" button; typing "更新版本" in Feishu also makes the Router call the update tool and restart after replying.

<details>
<summary>Run from source or contribute?</summary>

```bash
git clone https://github.com/blankPen/router-agent.git
cd router-agent
pnpm install --registry=https://registry.npmjs.org/
pnpm build
pnpm link --global      # then use `ra` directly; without linking, use `node bin/ra.js <command>`
```

</details>

**2 · Initialize: two ways, pick either one**

Initialization results in `~/.router-agent/config.yaml`. Both paths write the same config, so you can mix them and run them repeatedly.

| Path | Best for | Entry point |
|-|-|-|
| **Web setup page** (recommended) | First-time setup; you want live detection results while filling it in | `ra start` opens `#setup` |
| **CLI wizard** | Remote / headless machines; configuring chats and members in one go | `ra init` |

**Path A · Web setup page**

```bash
ra start              # resident service; opens http://127.0.0.1:3083/#setup when ready
ra status
ra web                # reopen the dashboard later
```

The page only covers the five things needed to get running, with a completion checklist at the top:

1. **LLM Provider**: Base URL / model / API key — all three are required; both OpenAI-compatible and Anthropic-compatible APIs are supported. The key is written only to `config.yaml` and never echoed back; `RA_LLM_*` environment variables can override it. **Import from local config** in the card header opens a picker to import an existing provider from Claude Code, CCSwitch, Pi, OpenCode or Magpie (the source files are read-only and the key is never sent back to the page).
2. **Worker runtime**: Orca / Claude Code / ACP Agent cards, with automatic checks for the CLI, version, ACP dependencies and login state, plus install guidance and a real handshake test. The runtime's own options show up under the cards (for Orca: which **Agent** to launch — leave it empty to follow Orca's own default, or pick `codex` etc.).
3. **Projects**: add a local project (system directory picker + Git detection) or a Git project (cloned into `~/.router-agent/repos`; `RA_HOME` changes the root).
4. **Feishu bot**: enter App ID / App Secret (the secret is written only to lark-cli's encrypted store); router-agent always uses the fixed `~/.router-agent-lark` profile. After saving you can check authorization status and complete the Device Flow login from the same page.
5. **Chats and bindings**: at least one monitored chat; bind it to a project so dispatch stops asking.

![Web setup page: five-step checklist, LLM Provider and runtime cards](docs/assets/readme/setup-overview-dark.png)

After saving, the page asks for a restart; click **Save and restart** to hot-restart the daemon (the browser page stays open). On a remote or headless machine use `ra start --no-open` to only print the dashboard URL.

**Path B · CLI wizard**

```bash
ra init
```

The wizard walks through: **repository** (pick a Git repo from `orca repo list` for the Orca runtime; enter an absolute local path for other runtimes) → **Feishu bot** (write an existing App ID + Secret now / create a new app in the browser / skip and fill it in later on the web config page) → **user authorization** (optional; used to search chats and members by name) → **monitored chats** → **allowed members** → **bot identity** → **chat bindings**. It only asks for required fields; `ra init --yes` writes defaults only and is script-friendly.

The two paths can hand off to each other: run `ra init` for the bot and chats, then use the web page for LLM / projects / bindings. The page submits only the fields you changed, so it won't overwrite the rest of the CLI-written config.

**3 · Self-check and simulate**

```bash
ra doctor                                              # config / runtimes / Feishu / model / port — all green before going further
ra simulate --infer --text "change the README port from 3000 to 3083" --dry-run   # gate + triage only, nothing persisted
ra simulate --text "hey, are you there" --dry-run      # verifies the reply path also goes through Pi
ra simulate --text "change the README port from 3000 to 3083"   # drop --dry-run to persist; still no dispatch
ra tickets                                             # simulated tickets show up here
```

For a real acceptance run, mention the bot in a chat with a small request, then confirm in order:

1. `ra logs | grep trigger:ingested` shows the message arriving;
2. `ra tickets` shows a ticket, and `ra ticket <id>` shows its scope and strength;
3. `orca worktree list --json` (for the `orca` runtime; use `git worktree list` for other runtimes) shows `ra-tk-<number>-<semantic slug>` with branch `ra/tk-<number>-<semantic slug>` (the directory name matches the branch, with `/` replaced by `-`), and the runtime shows an agent session (an agent terminal for Orca);
4. after the Worker runs `ra report`, the stage in `ra ticket <id>` moves between `running → review/blocked`;
5. when the PR / MR is merged or closed, the ticket becomes `done` and Feishu gets one closure notification; the workspace is kept for 24 hours and then reclaimed by the scheduled task (a manual stop reclaims it immediately).

## How it works

```text
Sources (Feishu / GitHub / GitLab)
        │ Trigger
        ▼
Router (AgentLoop + DecisionEngine(Pi) + HTTP API + Web)
        │ Engine (single state writer)
        ▼
Domain core (zero-dep TS: Ticket / Mandate / Assignment / Stage / Policy)
        │ Assignment
        ▼
WorkerRuntime port ── OrcaRuntime (default) / ClaudeCodeRuntime / AcpRuntime (acp and 7 acp-*)
```

A message goes through four steps:

1. **Listen**: a resident consumer reads Feishu group / direct messages, and a deterministic gate applies the allowlist and `@` rules.
2. **Decide**: candidates that weren't explicitly assigned go to Pi triage, producing one of `accept / stop / ignore / unavailable`.
3. **Dispatch**: on acceptance, the Router creates a ticket and mandate, confirms "project + base branch", then dispatches through the configured runtime; if either is missing it asks in the conversation first.
4. **Follow**: the Worker reports with `ra report`; the Router advances the stage and syncs progress, then closes the loop when the PR is merged or closed.

Three design constraints:

- **Engine is the single writer**: the Router, Workers and dashboard never write SQLite directly.
- **WorkerRuntime is the only extension point**: another runtime takes one adapter, with no changes to the core or Router.
- **All outbound notifications go through the Outbox**: idempotency key plus exponential backoff starting at 2s (capped at 60s).

The full layering, triage boundaries, session mechanics and ticket lifecycle are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (Chinese).

## Core mechanics

- **Listen**: `mode: all` receives every message, `mode: mention` only `@bot`; a per-chat `allowed` list strictly limits who can trigger work; image messages are downloaded and their local paths passed to the Worker.
- **Decide**: a deterministic gate runs first, Pi triage second; triage tools are read-only, writes always go through the Engine, and timeouts / budget overruns land as `unavailable`.
- **Remember**: each person in a chat gets a persisted session, restored after restart, released from memory after 30 idle minutes, compacted by Pi natively; `/new` only resets the sender's session.
- **Dispatch**: a ticket needs an explicit task + project + base branch; missing pieces become a dispatch draft with a follow-up question, and chat bindings skip the Q&A.
- **Follow**: `--reply` is posted verbatim, progress is merged on the `progress.syncMs` interval, and the Router probes the session transcript when the Worker goes silent.
- **Observe**: greetings get a polite Pi reply, real requests get exactly one thread message, and a merged / closed PR closes the loop automatically.

Details: [listen / decide / remember / dispatch / follow](docs/ARCHITECTURE.md) · [replies, dashboard and logs](docs/OPERATIONS.md) (Chinese).

## Runtime: worker runtimes

Workers don't run inside the Router process. The Router picks an adapter from `runtime.default`, and that adapter creates the workspace, launches the agent, delivers the ticket and carries follow-ups:

| runtime id | How it launches | Best for |
|-|-|-|
| `orca` (default) | Orca creates the worktree + agent terminal (Claude Code by default; configurable) | You already manage repos with Orca and want to watch the terminal |
| `claude-code` | `git worktree` + background `claude --bg` session | You don't use Orca and just want Claude Code |
| `codex-app` | `git worktree` + `codex app-server`, preferring the CLI bundled with the Codex app | Use Codex and want Router-created threads visible in the Codex desktop app |
| `acp` / `acp-*` | ACP child process (Claude / Codex / Gemini / OpenCode and friends) | You want to plug in another ACP agent |

Project lists are kept per runtime: Orca uses repository selectors, other runtimes need absolute local paths. Switching the default only affects new tickets. The full comparison, ACP agent catalog, tool policy and spec injection are in [docs/RUNTIME.md](docs/RUNTIME.md) (Chinese).

## Configuration

The config file is `~/.router-agent/config.yaml`. A minimal working setup has four sections:

```yaml
llm:
  baseUrl: https://api.example.com/v1
  model: claude-sonnet-5-5
  apiKey: sk-xxx

feishu:
  appId: cli_xxx
  allowed: [alice@company.com]   # members allowed to start work (email recommended, ou_xxx still accepted)
  botOpenIds: []          # leave empty to auto-detect the bot by appId; set ou_xxx to override (advanced)
  chats:
    - chat: oc_xxx
      mode: mention

policy:
  acceptMode: auto

projects:
  - name: router-agent
    repo: name:dsh/router-agent
    defaultBranch: main
```

Prefer emails in `allowed` (they are resolved to open_ids, so switching the app does not break the list); `ou_xxx` still works. The bot identity is auto-detected from `feishu.appId` by default, and `botOpenIds` is only an advanced manual override; `ra doctor` fails with the reason when auto-detection fails. An empty `allowed` list also fails the `ra doctor` required-field check.

Common tweaks don't require editing the whole file:

```bash
ra config set policy.acceptMode observe          # observe first, no dispatch
ra config set project.router-agent "name:dsh/router-agent@main"
ra config set chatBinding.oc_xxx "router-agent@main"
ra config set runtime.default claude-code
ra config set runtime.options.orca.agent codex   # Orca dispatches with Codex; default is Claude Code
ra config edit                                   # edit the whole file in $EDITOR
```

Every field, the `ra config set` allowlist, runtime options, environment variables, model / Feishu bot / project setup, the admission matrix and idle governance are in [docs/CONFIGURATION.md](docs/CONFIGURATION.md) (Chinese).

## Commands

| Command | Description |
|-|-|
| `ra init` | Interactive setup (`--yes` skips questions) |
| `ra doctor` | Preflight: config / runtimes / Feishu / model / port (`--json` for machines) |
| `ra simulate` | Simulate a local message to verify gate + Pi triage, without dispatch (`--infer` runs Pi triage, `--dry-run` doesn't persist) |
| `ra start [--foreground]` | Start the resident service (background by default) and open the web setup page once ready; `--no-open` only prints the URL |
| `ra stop` | Stop the service |
| `ra status` | Service status + ticket overview |
| `ra web` | Reopen the web dashboard |
| `ra tickets [--stage <stage>]` | List tickets; `--stage` accepts `todo` / `running` / `review` / `blocked` / `done` |
| `ra ticket <id> [--stop]` | Ticket details (stage / assignment / reports / inputs); `--stop` stops the ticket and closes its worker terminal |
| `ra logs [--follow]` | Last 50 log lines; `--follow` keeps tailing |
| `ra update [--check]` | Check and upgrade to the latest npm version: runs `npm install -g router-agent@latest` and restarts the running service; `--no-restart` installs only, `--registry` picks a registry, `--force` installs globally even from a source / linked checkout, `--json` for machines |
| `ra runtime [list]` | Probe local ACP agents: status / version / source (`--json` for machines) |
| `ra runtime install <id>` | Install an ACP adapter into `~/.router-agent/runtimes/<agent>` |
| `ra runtime uninstall <id>` | Remove an ra-managed ACP adapter |
| `ra runtime check <id>` | Full ACP handshake (`initialize` + `session/new`) |
| `ra runtime login <id>` | Interactive login (provided by the agent: `acp-claude` runs `claude`, `acp-codex` runs `codex-acp login`) |
| `ra config` | View config; `config set <key> <value>` changes one key (including `project.<name>` / `chatBinding.<chat>` / `chatMode.<chat>` / `chatAllow.<chat>` / `progress.syncMs` / `progress.probeMs`); `config edit` edits the whole file |
| `ra report` | Worker-side reporting: state, summary, `--reply` (literal / `@file` / `-`), PR link and `--ack` |
| `ra doc` | Worker-side Feishu doc creation; put the returned link in `--reply` for long results |

The global option `--home <dir>` switches the state directory (for tests and multiple instances). The reporting protocol and field details are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#上报协议) (Chinese).

## Development

```bash
pnpm test        # 740 tests pass (4 skipped by default, including the live Pi check)
pnpm typecheck
pnpm build       # tsc + esbuild (web dashboard and Markdown assets)
pnpm check       # typecheck + test
RA_PI_VERIFY=1 npx vitest run tests/verify-pi-live.test.ts   # real Pi + real model (skipped by default)
```

Publishing is automated by GitHub Actions: merging into `main` bumps the patch version and publishes
to npm (merges that only touch docs / tests / CI are skipped; bump the version in the PR for
minor / major releases). Pushing a `v*` tag or running the workflow manually still works.
See [docs/PUBLISHING.md](docs/PUBLISHING.md) for details.

Source layout:

```text
src/core/     domain core (model / stage / policy / engine / effects)
src/store/    SQLite (node:sqlite)
src/worker/   WorkerRuntime port, RuntimeRegistry, OrcaRuntime, ClaudeCodeRuntime, AcpRuntime, state.json polling, worker handbook
src/sources/  Feishu events, GitHub / GitLab PR / MR tracking
src/router/   AgentLoop, tool contracts, prompts, HTTP API
src/web/      React dashboard
src/cli/      ra commands
```

## Known limitations

- macOS only for now (the Orca runtime needs `orca-ide` on Linux).
- No auto-merge; PRs / MRs are tracked and reported, not merged.
- The GitHub / GitLab source is only used for PR / MR state tracking; it does not consume issues or comments.
- Runtime-specific behavior, attachment / model limits and the Pi version constraint are listed in [docs/OPERATIONS.md](docs/OPERATIONS.md#已知限制) (Chinese).

## Documentation

The detailed docs are currently Chinese-only.

| Document | Contents |
|-|-|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Layering, the four steps, triage / session / dispatch mechanics, ticket stages and the `ra report` protocol |
| [docs/RUNTIME.md](docs/RUNTIME.md) | Worker runtime comparison, ACP agent catalog, worker tool policy and spec injection |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Full `config.yaml`, `ra config set`, environment variables, model and Feishu setup, admission matrix, idle governance |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Reply policy, web dashboard, log events, troubleshooting and known limitations |
| [docs/API.md](docs/API.md) | Local HTTP API |
| [docs/COMPARISON.md](docs/COMPARISON.md) | Gap analysis against the dsh-superagent prototype and transferable mechanisms |
| [docs/AGENT-ADAPTER-DESIGN.md](docs/AGENT-ADAPTER-DESIGN.md) | Agent tool adapter contract design: Orca / Claude Code / Codex |
| [docs/VERIFICATION.md](docs/VERIFICATION.md) | Real-environment verification records and remaining manual steps |
| [docs/show-me-router-flow.html](docs/show-me-router-flow.html) | Visual flow: message → triage → dispatch → report → closure |
| [README.md](README.md) | 简体中文版 |

The design reference is the Feishu document "router-agent（ra）技术设计方案".

---

Questions, suggestions, or want to plug in a new WorkerRuntime? Issues are welcome.
