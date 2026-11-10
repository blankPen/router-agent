import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const logPath = process.env.FAKE_CODEX_LOG

function log(entry) {
  if (!logPath) return
  try {
    appendFileSync(logPath, `${JSON.stringify(entry)}\n`, 'utf8')
  } catch {
    // 测试夹具不因日志失败而崩。
  }
}

log({ direction: 'argv', argv: process.argv })

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
    case 'thread/name/set':
      send({ id: message.id, result: {} })
      return
    case 'turn/start': {
      turnId = `turn_${Date.now()}`
      turnActive = true
      lastPrompt = message.params?.input?.map(item => item.text ?? '').join('') ?? ''
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