import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { simulate } from '../src/cli/simulate.js'
import { defaultConfig } from '../src/config.js'
import { resolvePiModelConfig } from '../src/router/model-config.js'
import { PiDecisionEngine } from '../src/router/pi-decision-engine.js'
import { RouterToolbox } from '../src/router/tools.js'

/**
 * 真实环境验证（方案第 7 节 Spike 验收）：
 *   RA_PI_VERIFY=1 npx vitest run tests/verify-pi-live.test.ts
 *
 * 会真实调用 LLM，默认跳过。
 */
const live = process.env.RA_PI_VERIFY === '1'

describe.skipIf(!live)('Pi 真实环境验证', () => {
  it('Pi 能产出合法 proposal，工具调用与 token 可审计，且超时/异常可降级', async () => {
    const model = resolvePiModelConfig({ home: process.env.HOME })
    const home = mkdtempSync(join(tmpdir(), 'ra-pi-live-'))
    const config = defaultConfig()
    config.home = home
    config.router.timeoutMs = 90_000
    config.router.tokenBudget = 64_000
    config.projects = [{ name: 'router-agent', repo: 'name:dsh/router-agent', branches: ['main'], defaultBranch: 'main' }]
    config.feishu.allowed = ['ou_live']

    const result = await simulate(
      {
        home,
        config,
        decisionEngine: store => new PiDecisionEngine({
          model,
          toolbox: new RouterToolbox({ store }),
          agentDir: join(home, 'pi'),
          timeoutMs: 90_000,
          tokenBudget: 64_000,
        }),
      },
      { text: '把 README 里的端口从 3000 改成 3083', dryRun: true },
    )

    expect(result.audits).toHaveLength(1)
    const audit = result.audits[0]!
    expect(audit.engine).toBe('pi')
    expect(audit.unavailableReason).toBeUndefined()
    expect(audit.durationMs).toBeGreaterThan(0)
    expect(audit.tokens.total).toBeGreaterThan(0)
    expect(result.decision).not.toBeNull()
    expect(result.decision?.decision).not.toBe('unavailable')
    // 工具调用序列可审计：Pi 正常会先 read/decide，至少要有一次工具调用记录。
    expect(audit.toolCalls.length).toBeGreaterThan(0)
  }, 120_000)
})