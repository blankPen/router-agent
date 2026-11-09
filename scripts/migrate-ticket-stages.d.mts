export const STAGE_MAP: Readonly<Record<string, string>>
export const STAGE_LABELS: Readonly<Record<string, string>>

export interface StageChange {
  from: string
  to: string
  count: number
}

export interface MigrationPlan {
  dbPath: string
  changes: StageChange[]
  unknown: { stage: string; count: number }[]
  total: number
}

export interface MigrationResult extends MigrationPlan {
  backupPath: string
  updated: number
}

export function parseArgs(argv: string[]): {
  db: string
  apply: boolean
  force: boolean
  json: boolean
  help: boolean
}
export function buildPlan(dbPath: string): MigrationPlan
export function runningPid(dbPath: string): number | null
export function applyMigration(dbPath: string, options?: { now?: Date }): MigrationResult
