export interface ForbiddenRule {
  label: string
  pattern: RegExp
}

export interface Match {
  rule: string
  line: number
  text: string
}

export interface ScanResult {
  file: string
  hits: Match[]
}

export const FORBIDDEN_VALUES: { companyEmailDomain: string; orgName: string }
export const ALLOWED_TENANT: string
export const ENCODED_DOT: string
export const FORBIDDEN_PATTERNS: ForbiddenRule[]
export const IGNORED_PREFIXES: string[]
export function isScannable(file: string): boolean
export function findMatches(content: string, patterns?: ForbiddenRule[]): Match[]
export function listTrackedFiles(cwd?: string): string[]
export function scanRepository(cwd?: string, patterns?: ForbiddenRule[]): ScanResult[]
