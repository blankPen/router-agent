import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { followFile } from '../src/cli/index.js'

afterEach(() => vi.useRealTimers())

describe('ra logs --follow', () => {
  it('从当前末尾开始，只输出新追加的行', () => {
    vi.useFakeTimers()
    const path = join(mkdtempSync(join(tmpdir(), 'ra-logs-')), 'a.log')
    writeFileSync(path, 'old-1\nold-2\n')
    const lines: string[] = []
    const stop = followFile(path, line => lines.push(line), 100)

    appendFileSync(path, 'new-1\n')
    vi.advanceTimersByTime(120)
    expect(lines).toEqual(['new-1'])

    appendFileSync(path, 'new-2\nnew-3\n')
    vi.advanceTimersByTime(120)
    expect(lines).toEqual(['new-1', 'new-2', 'new-3'])

    stop()
    appendFileSync(path, 'after-stop\n')
    vi.advanceTimersByTime(120)
    expect(lines).toEqual(['new-1', 'new-2', 'new-3'])
  })
})
