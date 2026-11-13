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
  '@router-agent/core': resolve(import.meta.dirname, 'packages/core/src'),
  '@router-agent/infra': resolve(import.meta.dirname, 'packages/infra/src'),
  '@router-agent/runtime': resolve(import.meta.dirname, 'packages/runtime/src'),
  '@router-agent/runtime-orca': resolve(import.meta.dirname, 'packages/runtime-orca/src'),
  '@router-agent/runtime-claude-code': resolve(import.meta.dirname, 'packages/runtime-claude-code/src'),
  '@router-agent/runtime-codex': resolve(import.meta.dirname, 'packages/runtime-codex/src'),
  '@router-agent/runtime-herdr': resolve(import.meta.dirname, 'packages/runtime-herdr/src'),
  '@router-agent/runtime-acp': resolve(import.meta.dirname, 'packages/runtime-acp/src'),
  '@router-agent/runtime-t3code': resolve(import.meta.dirname, 'packages/runtime-t3code/src'),
  '@router-agent/channel': resolve(import.meta.dirname, 'packages/channel/src'),
  '@router-agent/channel-feishu': resolve(import.meta.dirname, 'packages/channel-feishu/src'),
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
