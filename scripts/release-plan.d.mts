export const SKIP_KEYWORD: string
export const BOT_ACTOR: string
export const CHANNEL_DIST_TAGS: Record<'main' | 'beta' | 'alpha', string>
export const PRERELEASE_BRANCHES: string[]

export type ReleaseBranch = 'main' | 'beta' | 'alpha'

export interface ReleaseContext {
  event: 'push' | 'tag' | 'workflow_dispatch'
  version: string
  beforeVersion: string | null
  changedFiles: string[]
  headMessage: string
  actor: string
  branch: ReleaseBranch
  latestStable?: string | null
  tagName?: string | null
  tagBranches?: string[]
}

export interface ReleasePlan {
  shouldPublish: boolean
  releaseVersion: string
  applyVersion: boolean
  distTag: string
  writeback: boolean
  reason: string
}

export function parseVersion(version: string): { major: number; minor: number; patch: number } | null
export function parsePrereleaseVersion(
  version: string,
): { major: number; minor: number; patch: number; channel: 'beta' | 'alpha'; seq: number } | null
export function parseReleaseTag(
  tagName: string,
): { channel: 'stable' | 'beta' | 'alpha'; version: string } | null
export function isShippableChange(files: string[]): boolean
export function planRelease(
  context: ReleaseContext,
  isPublished: (version: string) => boolean,
): ReleasePlan
