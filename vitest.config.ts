import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * 测试与源码统一走包别名（`#core/*` / `#infra/*` / `#runtime/*` / `#channel/*`）。
 * Node 运行时由 package.json 的 `imports` 解析，tsc 由 tsconfig.paths 解析，
 * vitest 这里补一份 alias，保证三处指向同一份源码。
 */
const alias = {
  '#core': resolve(import.meta.dirname, 'packages/core/src'),
  '#infra': resolve(import.meta.dirname, 'packages/infra/src'),
  '#runtime': resolve(import.meta.dirname, 'packages/runtime/src'),
  '#channel': resolve(import.meta.dirname, 'packages/channel/src'),
}

export default defineConfig({
  resolve: {
    alias: Object.entries(alias).map(([find, replacement]) => ({ find, replacement })),
  },
  test: {
    include: ['tests/**/*.test.ts', 'packages/*/tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20000,
    hookTimeout: 20000,
    pool: 'forks',
  },
})
