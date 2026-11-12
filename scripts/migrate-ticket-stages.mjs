#!/usr/bin/env node
/**
 * 工单阶段历史数据迁移：旧八阶段 → 新五阶段。
 *
 * 设计原则：
 * - 默认 dry-run，只统计不写库；必须显式传 --apply 才会更新 tickets.stage。
 * - 写库前先用 VACUUM INTO 生成一致性备份，回滚时直接恢复备份文件。
 * - 不修改 updated_at / closed_at，避免影响闲置治理与巡检的时间水位。
 * - 代码本身不会自动调用本脚本；是否执行由人工决定。
 *
 * 用法：
 *   node scripts/migrate-ticket-stages.mjs                 # dry-run（默认）
 *   node scripts/migrate-ticket-stages.mjs --apply         # 真正迁移（先备份）
 *   node scripts/migrate-ticket-stages.mjs --db /path/to/state.db
 *   node scripts/migrate-ticket-stages.mjs --json          # 机器可读输出
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

/** 旧阶段 → 新阶段。与 packages/core/src/stage.ts 的 LEGACY_STAGE_MAP 保持一致（有单测校验）。 */
export const STAGE_MAP = Object.freeze({
  draft: 'todo',
  accepted: 'todo',
  assigned: 'running',
  running: 'running',
  review: 'review',
  person: 'blocked',
  idle: 'blocked',
  closed: 'done',
})

export const STAGE_LABELS = Object.freeze({
  todo: '待办',
  running: '进行中',
  review: '审核中',
  blocked: '已阻塞',
  done: '已完成',
})

const NEW_STAGES = Object.freeze(Object.keys(STAGE_LABELS))

/** 解析命令行参数；未知参数直接报错，避免拼错后误以为已经执行。 */
export function parseArgs(argv) {
  const opts = {
    db: join(process.env.RA_HOME || join(homedir(), '.router-agent'), 'state.db'),
    apply: false,
    force: false,
    json: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--db':
        i += 1
        if (!argv[i]) throw new Error('--db 需要一个路径参数')
        opts.db = resolve(argv[i])
        break
      case '--apply':
        opts.apply = true
        break
      case '--force':
        opts.force = true
        break
      case '--json':
        opts.json = true
        break
      case '--help':
      case '-h':
        opts.help = true
        break
      default:
        throw new Error(`未知参数：${arg}（可用：--db / --apply / --force / --json / --help）`)
    }
  }
  return opts
}

function openDatabase(dbPath) {
  if (!existsSync(dbPath)) throw new Error(`数据库不存在：${dbPath}`)
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA busy_timeout = 5000')
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tickets'").get()
  if (!table) throw new Error(`不是 router-agent 状态库（缺少 tickets 表）：${dbPath}`)
  return db
}

function stageCounts(db) {
  const rows = db.prepare('SELECT stage, COUNT(*) AS count FROM tickets GROUP BY stage').all()
  return rows.map(row => ({ stage: String(row.stage), count: Number(row.count) }))
}

/**
 * 计算迁移计划，不改数据。
 * 返回 { dbPath, changes, unknown, total }：
 * - changes：只包含需要/可以映射的旧阶段及数量；
 * - unknown：既不是新阶段、也不在映射表里的值，出现时必须中止。
 */
export function buildPlan(dbPath) {
  const db = openDatabase(dbPath)
  try {
    const counts = stageCounts(db)
    const changes = []
    const unknown = []
    for (const { stage, count } of counts) {
      if (NEW_STAGES.includes(stage)) continue
      const to = STAGE_MAP[stage]
      if (!to) {
        unknown.push({ stage, count })
        continue
      }
      changes.push({ from: stage, to, count })
    }
    const total = counts.reduce((sum, item) => sum + item.count, 0)
    return { dbPath, changes, unknown, total }
  } finally {
    db.close()
  }
}

/** 判断 Router 是否仍在运行；运行中写库容易和 WAL 并发冲突。 */
export function runningPid(dbPath) {
  const pidFile = join(dirname(resolve(dbPath)), 'router-agent.pid')
  if (!existsSync(pidFile)) return null
  const pid = Number(readFileSync(pidFile, 'utf8').trim())
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    process.kill(pid, 0)
    return pid
  } catch {
    return null
  }
}

/**
 * 执行迁移：先备份，再在单个事务里按映射更新 stage。
 * 幂等：重复执行时旧阶段已被改写，第二次不会产生额外变化。
 */
export function applyMigration(dbPath, { now = new Date() } = {}) {
  const plan = buildPlan(dbPath)
  if (plan.unknown.length > 0) {
    throw new Error(`发现未知阶段值：${plan.unknown.map(item => `${item.stage}(${item.count})`).join(', ')}；已中止，请先人工确认`)
  }
  if (plan.changes.length === 0) return { ...plan, backupPath: '', updated: 0 }

  const db = openDatabase(dbPath)
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  let backupPath = `${dbPath}.bak.${stamp}`
  for (let i = 1; existsSync(backupPath); i += 1) backupPath = `${dbPath}.bak.${stamp}-${i}`
  try {
    // VACUUM INTO 生成包含 WAL 内容的一致性副本，比直接 cp 安全。
    db.prepare('VACUUM INTO ?').run(backupPath)
    let updated = 0
    db.exec('BEGIN IMMEDIATE')
    try {
      const stmt = db.prepare('UPDATE tickets SET stage = ? WHERE stage = ?')
      for (const { from, to } of plan.changes) {
        const result = stmt.run(to, from)
        updated += Number(result.changes ?? 0)
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    return { ...plan, backupPath, updated }
  } finally {
    db.close()
  }
}

function printHelp(stream) {
  stream(`工单阶段迁移：旧八阶段 → 新五阶段（默认 dry-run，不写库）

用法：
  node scripts/migrate-ticket-stages.mjs [选项]

选项：
  --db <path>   状态库路径（默认 $RA_HOME/state.db 或 ~/.router-agent/state.db）
  --apply       真正执行迁移；执行前生成 <db>.bak.<时间戳> 备份
  --force       Router 仍在运行时也允许写库（不推荐）
  --json        以 JSON 输出
  --help        显示帮助

阶段映射：
  draft     → todo       accepted → todo       assigned → running
  running   → running    review   → review     person   → blocked
  idle      → blocked    closed   → done
`)
}

function formatPlan(plan, opts) {
  const lines = []
  lines.push('工单阶段迁移：旧八阶段 → 新五阶段')
  lines.push(`数据库：${plan.dbPath}`)
  lines.push(`模式：${opts.apply ? 'apply（会写库）' : 'dry-run（只读，不写库）'}`)
  lines.push('')
  if (plan.changes.length === 0) {
    lines.push('没有需要迁移的旧阶段数据。')
  } else {
    lines.push('待迁移：')
    for (const item of plan.changes) {
      lines.push(`  ${item.from.padEnd(9)} → ${item.to.padEnd(8)} ${item.count} 张（${STAGE_LABELS[item.to]}）`)
    }
    const count = plan.changes.reduce((sum, item) => sum + item.count, 0)
    lines.push(`  合计 ${count} 张 / 库内 ${plan.total} 张`)
  }
  if (plan.unknown.length > 0) {
    lines.push('')
    lines.push('⚠️ 发现未知阶段值（不会迁移）：')
    for (const item of plan.unknown) lines.push(`  ${item.stage}：${item.count} 张`)
  }
  return lines.join('\n')
}

function main(argv) {
  let opts
  try {
    opts = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
  if (opts.help) {
    printHelp(text => process.stdout.write(text))
    return 0
  }

  const plan = buildPlan(opts.db)
  if (plan.unknown.length > 0) {
    process.stderr.write(`${formatPlan(plan, opts)}\n\n为避免误迁移，已中止；请先人工确认未知阶段值的来源。\n`)
    return 1
  }

  if (!opts.apply) {
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ mode: 'dry-run', ...plan }, null, 2)}\n`)
    } else {
      process.stdout.write(`${formatPlan(plan, opts)}\n`)
      if (plan.changes.length > 0) {
        process.stdout.write('\n未写入任何数据。确认无误后执行：\n  node scripts/migrate-ticket-stages.mjs --apply\n')
      }
    }
    return 0
  }

  const pid = runningPid(opts.db)
  if (pid && !opts.force) {
    process.stderr.write(`Router 仍在运行（pid ${pid}），请先执行 ra stop 再迁移；确需热迁移可加 --force。\n`)
    return 1
  }

  const result = applyMigration(opts.db)
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ mode: 'apply', ...result }, null, 2)}\n`)
    return 0
  }
  process.stdout.write(`${formatPlan(result, opts)}\n`)
  if (result.updated === 0) {
    process.stdout.write('\n无需更新。\n')
    return 0
  }
  process.stdout.write(`\n已备份：${result.backupPath}`)
  process.stdout.write(`\n已更新：${result.updated} 张\n`)
  process.stdout.write('\n回滚方式（先停服务）：\n')
  process.stdout.write(`  ra stop\n  cp "${result.backupPath}" "${result.dbPath}"\n  rm -f "${result.dbPath}-wal" "${result.dbPath}-shm"\n  ra start\n`)
  return 0
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (invokedPath === import.meta.url) {
  process.exitCode = main(process.argv.slice(2))
}
