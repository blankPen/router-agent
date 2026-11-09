export const SKIP_KEYWORD: string
export const BOT_ACTOR: string

export interface ReleaseContext {
  event: 'push' | 'tag' | 'workflow_dispatch'
  version: string
  beforeVersion: string | null
  changedFiles: string[]
  headMessage: string
  actor: string
}

export interface ReleasePlan {
  shouldPublish: boolean
  releaseVersion: string
  autoBump: boolean
  reason: string
}

export function parseVersion(version: string): { major: number; minor: number; patch: number } | null
export function isShippableChange(files: string[]): boolean
export function planRelease(
  context: ReleaseContext,
  isPublished: (version: string) => boolean,
): ReleasePlan
