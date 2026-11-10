import { describe, expect, it } from 'vitest'
import { evaluatePublishResult, parsePublishJson } from '../../scripts/publish-result.mjs'

/** npm 10（Node 22 自带）成功发布时的 JSON 输出形态。 */
const npm10Success = JSON.stringify({
  id: 'router-agent@0.3.7',
  name: 'router-agent',
  version: '0.3.7',
  size: 1024,
  unpackedSize: 2048,
  shasum: 'abc',
  integrity: 'sha512-xxx',
  filename: 'router-agent-0.3.7.tgz',
  files: [],
  entryCount: 2,
  bundled: [],
})

/** npm 11 成功发布时的 JSON 输出形态（外层多一层包名）。 */
const npm11Success = JSON.stringify({
  'router-agent': {
    id: 'router-agent@0.3.7',
    name: 'router-agent',
    version: '0.3.7',
    filename: 'router-agent-0.3.7.tgz',
  },
})

/** npm 发布失败时的 JSON 输出形态。 */
const npmFailure = JSON.stringify({
  error: {
    code: 'ENEEDAUTH',
    summary: 'This command requires you to be logged in to https://registry.npmjs.org/',
    detail: 'You need to authorize this machine using `npm adduser`',
  },
})

const base = {
  stdout: '',
  stderr: '',
  exitCode: 0,
  expectedName: 'router-agent',
  expectedVersion: '0.3.7',
}

describe('发布结果判定', () => {
  it('解析不了 JSON 时返回 null', () => {
    expect(parsePublishJson('')).toBeNull()
    expect(parsePublishJson('   ')).toBeNull()
    expect(parsePublishJson('not json')).toBeNull()
    expect(parsePublishJson('{"a":1}')).toEqual({ a: 1 })
  })

  it('npm 10 的成功输出判定为发布成功', () => {
    const result = evaluatePublishResult({ ...base, stdout: npm10Success })
    expect(result.ok).toBe(true)
    expect(result.id).toBe('router-agent@0.3.7')
    expect(result.version).toBe('0.3.7')
    expect(result.staged).toBe(false)
  })

  it('npm 11 的成功输出（外层包名）同样判定为发布成功', () => {
    const result = evaluatePublishResult({ ...base, stdout: npm11Success })
    expect(result.ok).toBe(true)
    expect(result.id).toBe('router-agent@0.3.7')
  })

  it('退出码非 0 时判定失败，并带上 npm 的错误码', () => {
    const result = evaluatePublishResult({
      ...base,
      exitCode: 1,
      stdout: npmFailure,
      stderr: 'npm error code ENEEDAUTH',
    })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('ENEEDAUTH')
    expect(result.message).toContain('ENEEDAUTH')
  })

  it('退出码非 0 且没有 JSON 输出时，退回 stderr 末几行', () => {
    const result = evaluatePublishResult({
      ...base,
      exitCode: 1,
      stdout: '',
      stderr: 'npm error code E403\nnpm error not allowed to publish',
    })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('EPUBLISH')
    expect(result.message).toContain('E403')
  })

  it('退出码为 0 但输出里带 error 时仍判定失败', () => {
    const result = evaluatePublishResult({ ...base, stdout: npmFailure })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('ENEEDAUTH')
  })

  it('npm 报 E_STAGE_REQUIRED 时提示 token 权限不足', () => {
    const stageRequired = JSON.stringify({
      error: {
        code: 'E_STAGE_REQUIRED',
        summary: 'Publishing requires a staged version',
        detail: 'Your token does not have permission to publish directly',
      },
    })
    const result = evaluatePublishResult({ ...base, exitCode: 1, stdout: stageRequired })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('E_STAGE_REQUIRED')
    expect(result.message).toContain('stage 权限')
  })

  it('退出码为 0 但输出不是 JSON 时判定失败', () => {
    const result = evaluatePublishResult({ ...base, stdout: 'hello' })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('EPUBLISH_OUTPUT')
  })

  it('npm 只写进暂存区（stageId）时判定失败', () => {
    const staged = JSON.stringify({
      id: 'router-agent@0.3.7',
      name: 'router-agent',
      version: '0.3.7',
      stageId: '9f2a3c',
    })
    const result = evaluatePublishResult({ ...base, stdout: staged })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('EPUBLISH_STAGED')
    expect(result.staged).toBe(true)
    expect(result.message).toContain('暂存区')
  })

  it('stderr 提示已暂存（npm 11 的 staged 提示）时同样判定失败', () => {
    const result = evaluatePublishResult({
      ...base,
      stdout: npm10Success,
      stderr: 'npm notice package router-agent@0.3.7 has been staged with tag latest',
    })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('EPUBLISH_STAGED')
    expect(result.staged).toBe(true)
  })

  it('发布的包名或版本与预期不符时判定失败', () => {
    const other = JSON.stringify({
      id: 'router-agent@0.3.6',
      name: 'router-agent',
      version: '0.3.6',
    })
    const result = evaluatePublishResult({ ...base, stdout: other })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('EPUBLISH_MISMATCH')
  })
})
