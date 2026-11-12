import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { applyMigration, buildPlan, STAGE_MAP } from '../../scripts/migrate-ticket-stages.mjs'
import { LEGACY_STAGE_MAP, STAGE_VALUES } from '#core/stage.js'

function tempDb(rows: { id: string; stage: string }[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'ra-stage-migration-'))
  const path = join(dir, 'state.db')
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE tickets (id TEXT PRIMARY KEY, stage TEXT NOT NULL)')
  const insert = db.prepare('INSERT INTO tickets (id, stage) VALUES (?, ?)')
  for (const row of rows) insert.run(row.id, row.stage)
  db.close()
  return path
}

function stages(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath)
  try {
    return (db.prepare('SELECT id, stage FROM tickets ORDER BY id').all() as { id: string; stage: string }[])
      .map(row => `${row.id}:${row.stage}`)
  } finally {
    db.close()
  }
}

describe('工单阶段迁移脚本', () => {
  it('脚本映射表与内核 LEGACY_STAGE_MAP 完全一致', () => {
    expect(STAGE_MAP).toEqual(LEGACY_STAGE_MAP)
    expect(new Set(Object.values(STAGE_MAP))).toEqual(new Set(STAGE_VALUES))
  })

  it('dry-run 只统计旧阶段，不写库', () => {
    const db = tempDb([
      { id: 'a', stage: 'accepted' },
      { id: 'b', stage: 'assigned' },
      { id: 'c', stage: 'person' },
      { id: 'd', stage: 'closed' },
      { id: 'e', stage: 'running' },
    ])

    const plan = buildPlan(db)
    expect(plan.unknown).toEqual([])
    expect(plan.changes).toEqual(expect.arrayContaining([
      { from: 'accepted', to: 'todo', count: 1 },
      { from: 'assigned', to: 'running', count: 1 },
      { from: 'person', to: 'blocked', count: 1 },
      { from: 'closed', to: 'done', count: 1 },
    ]))
    // dry-run 后库里的值保持不变。
    expect(stages(db)).toEqual(['a:accepted', 'b:assigned', 'c:person', 'd:closed', 'e:running'])
  })

  it('apply 先备份再迁移，且可重复执行', () => {
    const db = tempDb([
      { id: 'a', stage: 'accepted' },
      { id: 'b', stage: 'assigned' },
      { id: 'c', stage: 'idle' },
      { id: 'd', stage: 'closed' },
      { id: 'e', stage: 'review' },
    ])

    const result = applyMigration(db, { now: new Date('2026-11-09T12:00:00.000Z') })
    expect(result.updated).toBe(4)
    expect(result.backupPath).toContain('.bak.2026-11-09T12-00-00-000Z')
    expect(existsSync(result.backupPath)).toBe(true)
    expect(stages(db)).toEqual(['a:todo', 'b:running', 'c:blocked', 'd:done', 'e:review'])
    // 备份保留迁移前的值。
    expect(stages(result.backupPath)).toEqual(['a:accepted', 'b:assigned', 'c:idle', 'd:closed', 'e:review'])

    const again = applyMigration(db)
    expect(again.updated).toBe(0)
    expect(again.changes).toEqual([])
  })

  it('出现未知阶段值时中止且不写库', () => {
    const db = tempDb([
      { id: 'a', stage: 'accepted' },
      { id: 'b', stage: 'weird' },
    ])

    expect(() => applyMigration(db)).toThrow(/未知阶段值/)
    expect(stages(db)).toEqual(['a:accepted', 'b:weird'])
  })
})
