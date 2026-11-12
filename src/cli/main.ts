#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { checkbox, confirm, input, password, select } from '@inquirer/prompts'
import { realRunner } from '#infra/process.js'
import { createLarkRunner } from '@router-agent/channel-feishu'
import { runCli, type CliIo } from './index.js'
import type { Prompter } from './prompts.js'

const prompts: Prompter = {
  input: opts => input(opts),
  password: opts => password({ message: opts.message, mask: opts.mask }),
  // inquirer 的泛型签名与我们的抽象等价，这里做一次类型收敛。
  select: opts => select(opts as never) as never,
  checkbox: opts => checkbox(opts as never) as never,
  confirm: opts => confirm(opts),
}

const io: CliIo = {
  stdout: line => process.stdout.write(`${line}\n`),
  stderr: line => process.stderr.write(`${line}\n`),
  env: process.env as Record<string, string | undefined>,
  orca: realRunner('orca'),
  claude: realRunner('claude'),
  git: realRunner('git'),
  herdr: realRunner('herdr'),
  lark: createLarkRunner(),
  stream: (argv, env) => new Promise<number>(resolve => {
    const child = spawn('lark-cli', argv, { stdio: 'inherit', env })
    child.on('error', () => resolve(127))
    child.on('close', code => resolve(code ?? 1))
  }),
  ...(process.stdin.isTTY ? { prompts } : {}),
}

runCli(process.argv.slice(2), io)
  .then(code => {
    if (code !== 0) process.exitCode = code
  })
  .catch(error => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  })
