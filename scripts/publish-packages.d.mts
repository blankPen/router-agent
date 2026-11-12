export const PUBLISH_ORDER: string[]
export function packageDir(name: string): string
export function packagePath(name: string): string
export function syncManifest<T>(pkg: T, targetVersion: string): T
export function syncRootDependencies<T>(pkg: T, targetVersion: string): T
export function writeVersionedManifests(targetVersion: string): void
export function assertPackable(name: string, pkg: { exports?: Record<string, unknown>; repository?: unknown }): void
export function undeclaredDependencies(dir: string): string[]
export function scopeDiagnostic(name: string, stdout: string, stderr: string): string
export function assertPublisher(packageName: string, whoami: string, owners: string): string
export function verifyPublisher(packageName?: string, scope?: string): string
export function versionExists(name: string, targetVersion: string): boolean
export function assertUnpublished(names: readonly string[], targetVersion: string): void
