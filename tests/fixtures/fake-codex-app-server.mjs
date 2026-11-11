import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const logPath = process.env.FAKE_CODEX_LOG
/** 轮次历史落盘位置：模拟 Codex 把 rollout 写在磁盘上，进程重启后仍能读到。 */
const turnsPath = process.env.FAKE_CODEX_TURNS

function log(entry) {
  if (!logPath) return
  try {
    appendFileSync(logPath, `${JSON.stringify(entry)}\n`, 'utf8')
  } catch {
    // 测试夹具不因日志失败而崩。
  }
}

log({ direction: 'argv', argv: process.argv, env: { CODEX_HOME: process.env.CODEX_HOME ?? null } })

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

let threadId = 'thr_1'
let turnId = 'turn_1'
let turnActive = false
let pendingApprovalId = null
let approvalDecision = null
let threadCwd = process.cwd()
let lastPrompt = ''
/** 历史轮次；thread/turns/list 按它返回，用来模拟「上一轮被中断」。 */
let turnHistory = loadTurns()

function loadTurns() {
  if (!turnsPath || !existsSync(turnsPath)) return []
  try {
    const parsed = JSON.parse(readFileSync(turnsPath, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveTurns() {
  if (!turnsPath) return
  try {
    writeFileSync(turnsPath, JSON.stringify(turnHistory), 'utf8')
  } catch {
    // 测试夹具不因落盘失败而崩。
  }
}

function notify(method, params) {
  send({ method, params })
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })

rl.on('line', line => {
  if (!line.trim()) return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  log({ direction: 'in', message })

  // 客户端对审批请求的响应。
  if (message.id === pendingApprovalId && message.result) {
    approvalDecision = message.result.decision ?? 'decline'
    pendingApprovalId = null
    finishPermissionTurn()
    return
  }

  switch (message.method) {
    case 'initialize':
      send({ id: message.id, result: { userAgent: 'fake-codex-app-server/0.0.0', codexHome: process.env.CODEX_HOME ?? '' } })
      return
    case 'initialized':
      return
    case 'thread/start':
      threadId = message.params?.threadId ?? 'thr_1'
      threadCwd = message.params?.cwd ?? process.cwd()
      send({
        id: message.id,
        result: {
          thread: {
            id: threadId,
            sessionId: threadId,
            cwd: threadCwd,
            status: { type: 'idle' },
            name: null,
            preview: '',
            source: 'vscode',
          },
          model: message.params?.model ?? 'fake-model',
        },
      })
      notify('thread/started', {
        thread: { id: threadId, sessionId: threadId, cwd: threadCwd, status: { type: 'idle' }, preview: '' },
      })
      return
    case 'thread/resume':
      threadId = message.params?.threadId ?? threadId
      threadCwd = message.params?.cwd ?? threadCwd
      send({
        id: message.id,
        result: {
          thread: { id: threadId, sessionId: threadId, cwd: threadCwd, status: { type: 'idle' }, preview: 'resumed' },
          model: 'fake-model',
        },
      })
      return
    case 'thread/read':
      send({
        id: message.id,
        result: {
          thread: { id: threadId, sessionId: threadId, cwd: threadCwd, status: { type: 'idle' }, preview: 'fake' },
        },
      })
      return
    case 'thread/list':
      send({ id: message.id, result: { data: [], nextCursor: null } })
      return
    case 'thread/turns/list': {
      if (process.env.FAKE_CODEX_TURNS_ERROR) {
        send({ id: message.id, error: { code: -32603, message: 'turns list unavailable' } })
        return
      }
      // 按真实协议返回：data 是轮次数组，最新的一轮在前。
      const limit = message.params?.limit ?? 5
      send({ id: message.id, result: { data: turnHistory.slice(0, limit), nextCursor: null } })
      return
    }
    case 'thread/name/set':
      send({ id: message.id, result: {} })
      return
    case 'turn/start': {
      turnId = `turn_${Date.now()}`
      turnActive = true
      lastPrompt = message.params?.input?.map(item => item.text ?? '').join('') ?? ''
      const record = {
        id: turnId,
        rootTurnId: turnId,
        items: [{ type: 'userMessage', id: `um_${turnId}`, content: [{ type: 'text', text: lastPrompt }] }],
        itemsView: 'full',
        status: 'inProgress',
        error: null,
        startedAt: Math.floor(Date.now() / 1000),
        completedAt: null,
        durationMs: null,
      }
      turnHistory.unshift(record)
      saveTurns()
      notify('turn/started', {
        threadId,
        turn: { id: turnId, status: 'inProgress', items: [] },
      })
      send({ id: message.id, result: { turn: { id: turnId } } })
      if (lastPrompt.includes('PERMISSION:')) {
        pendingApprovalId = 9001
        send({
          id: 9001,
          method: 'item/commandExecution/requestApproval',
          params: {
            threadId,
            turnId,
            itemId: 'item_cmd',
            command: lastPrompt.split('PERMISSION:')[1] ?? 'rm -rf /',
            cwd: threadCwd,
            startedAtMs: Date.now(),
          },
        })
        return
      }
      const delay = lastPrompt.includes('SLOW') ? 300 : 10
      setTimeout(() => {
        if (!turnActive) return
        emitAssistant(`收到：${lastPrompt}`)
        completeTurn('completed')
      }, delay)
      return
    }
    case 'turn/steer':
      send({ id: message.id, result: {} })
      notify('item/agentMessage/delta', {
        threadId,
        turnId: message.params?.expectedTurnId ?? turnId,
        itemId: 'item_steer',
        delta: `追加：${message.params?.input?.map(item => item.text ?? '').join('') ?? ''}`,
      })
      return
    case 'turn/interrupt':
      send({ id: message.id, result: {} })
      turnActive = false
      {
        const interruptedId = message.params?.turnId ?? turnId
        const record = turnHistory.find(t => t.id === interruptedId)
        if (record) {
          record.status = 'interrupted'
          saveTurns()
        }
      }
      notify('turn/completed', {
        threadId,
        turn: { id: message.params?.turnId ?? turnId, status: 'interrupted', items: [] },
      })
      return
    default:
      send({ id: message.id, error: { code: -32601, message: `unsupported ${message.method}` } })
  }
})

function emitAssistant(text) {
  notify('item/started', {
    threadId,
    turnId,
    item: { type: 'agentMessage', id: 'item_msg', text: '' },
    startedAtMs: Date.now(),
  })
  notify('item/agentMessage/delta', { threadId, turnId, itemId: 'item_msg', delta: text })
  notify('item/completed', {
    threadId,
    turnId,
    item: { type: 'agentMessage', id: 'item_msg', text },
    completedAtMs: Date.now(),
  })
}

function completeTurn(status) {
  turnActive = false
  const record = turnHistory.find(t => t.id === turnId)
  if (record) {
    record.status = status
    record.completedAt = Math.floor(Date.now() / 1000)
    saveTurns()
  }
  notify('turn/completed', {
    threadId,
    turn: { id: turnId, status, items: [], durationMs: 10 },
  })
}

function finishPermissionTurn() {
  const accepted = approvalDecision === 'accept'
  emitAssistant(accepted ? 'permission:accept' : 'permission:decline')
  completeTurn('completed')
}
