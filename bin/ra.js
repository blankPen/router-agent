#!/usr/bin/env node
// ra 的入口 shim：转发到构建产物。
import('../dist/cli/main.js').catch(error => {
  console.error('router-agent 尚未构建，请先运行 pnpm build')
  console.error(error)
  process.exit(1)
})
