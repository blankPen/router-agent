import { describe, expect, it } from 'vitest'
import { buildResumeHint, resumeCommand, resumeSpecOf, shellQuote } from '../../src/worker/resume.js'

describe('resume 命令拼装', () => {
  it('空串也生成合法的单引号参数', () => {
    expect(shellQuote('')).toBe("''")
  })

  it('普通路径与含空格/中文的路径都按单引号处理', () => {
    expect(shellQuote('/tmp/wt')).toBe("'/tmp/wt'")
    expect(shellQuote('/tmp/中文 目录')).toBe("'/tmp/中文 目录'")
  })

  it('路径里的单引号被正确转义', () => {
    expect(shellQuote("/tmp/a b'c")).toBe("'/tmp/a b'\\''c'")
  })

  it('生成 cd 加恢复命令，参数逐个转义', () => {
    expect(resumeCommand('/tmp/a b', 'claude', ['--resume', "x'y"]))
      .toBe("cd '/tmp/a b' && claude '--resume' 'x'\\''y'")
  })

  it('没有参数时不留尾随空格', () => {
    expect(resumeCommand('/tmp/wt', 'opencode')).toBe("cd '/tmp/wt' && opencode")
  })
})

describe('运行时恢复映射', () => {
  it('已核实的运行时映射到各自 CLI，未知运行时返回 null', () => {
    expect(resumeSpecOf('acp-claude')?.command).toBe('claude')
    expect(resumeSpecOf('acp-codex')?.command).toBe('codex')
    expect(resumeSpecOf('codex-app')?.command).toBe('codex')
    expect(resumeSpecOf('acp-opencode')?.command).toBe('opencode')
    expect(resumeSpecOf('claude-cli')?.command).toBe('claude')
    // Orca 用哪个 Agent 由配置决定：没指定时只有「切回 Orca 终端」这条兜底。
    expect(resumeSpecOf('orca')?.command).toBeUndefined()
    expect(resumeSpecOf('orca', 'codex')?.command).toBe('codex')
    expect(resumeSpecOf('acp-gemini')).toBeNull()
  })

  it('有真实 sessionId 时按模板拼命令，并带上运行时提示', () => {
    expect(buildResumeHint('acp-claude', { workdir: '/tmp/a b', sessionId: 'sess_1' }))
      .toEqual({ command: "cd '/tmp/a b' && claude '--resume' 'sess_1'", sessionId: 'sess_1' })

    const codex = buildResumeHint('acp-codex', { workdir: '/tmp/wt', sessionId: 'thread_1' })
    expect(codex?.command).toBe("cd '/tmp/wt' && codex 'resume' 'thread_1'")
    expect(codex?.note).toContain('best-effort')

    const codexApp = buildResumeHint('codex-app', { workdir: '/tmp/wt', sessionId: 'thread_1' })
    expect(codexApp?.command).toBe("cd '/tmp/wt' && codex 'resume' 'thread_1'")
    expect(codexApp?.note).toContain('codex://threads')
  })

  it('claude-code 没有 sessionId 时退回 handle attach', () => {
    const hint = buildResumeHint('claude-code', { workdir: '/tmp/wt', handle: 'e46aaf7e' })
    expect(hint?.command).toBe("cd '/tmp/wt' && claude 'attach' 'e46aaf7e'")
    expect(hint?.note).toContain('attach')
  })

  it('orca 有会话记录时按 Agent 的语法恢复', () => {
    const hint = buildResumeHint('orca', { workdir: '/tmp/wt', sessionId: 'sess_orca', agentId: 'claude' })
    expect(hint?.command).toBe("cd '/tmp/wt' && claude '--resume' 'sess_orca'")
    expect(hint?.note).toContain('不再由 Orca 托管')

    const codex = buildResumeHint('orca', { workdir: '/tmp/wt', sessionId: 'thread_1', agentId: 'codex' })
    expect(codex?.command).toBe("cd '/tmp/wt' && codex 'resume' 'thread_1'")
  })

  it('orca 没有会话记录时退回 orca terminal switch，且不依赖 workdir', () => {
    const hint = buildResumeHint('orca', { workdir: '/tmp/wt', handle: 'term_abc' })
    expect(hint?.command).toBe("orca 'terminal' 'switch' '--terminal' 'term_abc'")
    expect(hint?.note).toContain('Orca')

    const gone = buildResumeHint('orca', { workdir: '/tmp/gone', handle: 'term_abc' }, { workdirExists: false })
    expect(gone?.command).toBe("orca 'terminal' 'switch' '--terminal' 'term_abc'")
    expect(gone?.note).toContain('工作目录已不存在')
  })

  it('缺少 workdir、sessionId 和 handle，或运行时未收录时返回 null', () => {
    expect(buildResumeHint('acp-claude', { sessionId: 'sess_1' })).toBeNull()
    expect(buildResumeHint('acp-claude', { workdir: '/tmp/wt' })).toBeNull()
    expect(buildResumeHint('orca', { workdir: '/tmp/wt' })).toBeNull()
  })

  it('工作目录不存在时仍返回命令，并追加提示', () => {
    const hint = buildResumeHint(
      'acp-claude',
      { workdir: '/tmp/gone', sessionId: 'sess_1' },
      { workdirExists: false },
    )
    expect(hint?.command).toContain('/tmp/gone')
    expect(hint?.note).toContain('工作目录已不存在')
  })
})
