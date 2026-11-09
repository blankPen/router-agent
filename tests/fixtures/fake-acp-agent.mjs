#!/usr/bin/env node
// 测试用的最小 ACP Agent：实现 initialize / session/new / session/load / session/prompt /
// session/cancel / session/request_permission，用于验证 AcpRuntime 的协议与权限逻辑。
import readline from 'node:readline'

const rl = readline.createInterface({ input: process.stdin })
let nextId = 1000
let nextSession = 1
const sessions = new Map()
const pendingRequests = new Map()

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}
function respond(id, result) {
  send({ jsonrpc: '2.0', id, result })
}
function respondError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}
function notify(method, params) {
  send({ jsonrpc: '2.0', method, params })
}
function update(sessionId, payload) {
  notify('session/update', { sessionId, update: payload })
}
function textChunk(sessionId, text) {
  update(sessionId, { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text } })
}
function contentText(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .map(block => (block && typeof block === 'object' && block.type === 'text' ? String(block.text ?? '') : ''))
    .join('')
}
function requestPermission(sessionId, command) {
  const id = nextId++
  return new Promise(resolve => {
    pendingRequests.set(id, resolve)
    send({
      jsonrpc: '2.0',
      id,
      method: 'session/request_permission',
      params: {
        sessionId,
        toolCall: {
          toolCallId: 'call_1',
          title: `Run ${command}`,
          kind: 'execute',
          status: 'pending',
          rawInput: { command },
        },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
        ],
      },
    })
  })
}

rl.on('line', line => {
  if (!line.trim()) return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message.method && message.id !== undefined) {
    void handleRequest(message)
    return
  }
  if (message.method) {
    handleNotification(message)
    return
  }
  if (message.id !== undefined && pendingRequests.has(message.id)) {
    const resolve = pendingRequests.get(message.id)
    pendingRequests.delete(message.id)
    const outcome = message.error
      ? { outcome: 'cancelled' }
      : (message.result?.outcome?.outcome === 'selected'
          ? { optionId: message.result.outcome.optionId }
          : { outcome: 'cancelled' })
    resolve(outcome)
  }
})

async function handleRequest(message) {
  const { id, method, params } = message
  if (method === 'initialize') {
    respond(id, {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        mcpCapabilities: { http: false, sse: false },
      },
      agentInfo: { name: 'fake-acp', version: '1.0.0' },
      authMethods: [],
    })
    return
  }
  if (method === 'session/new') {
    const sessionId = `sess_${nextSession++}`
    sessions.set(sessionId, { cancelled: false })
    respond(id, { sessionId })
    return
  }
  if (method === 'session/load') {
    const sessionId = String(params?.sessionId ?? '')
    sessions.set(sessionId, { cancelled: false })
    // 模拟历史重放：AcpRuntime 在 load 期间应忽略这些更新。
    update(sessionId, { sessionUpdate: 'user_message_chunk', messageId: 'u1', content: { type: 'text', text: '历史消息' } })
    textChunk(sessionId, 'resumed')
    respond(id, {})
    return
  }
  if (method === 'session/prompt') {
    const sessionId = String(params?.sessionId ?? '')
    const session = sessions.get(sessionId) ?? { cancelled: false }
    sessions.set(sessionId, session)
    session.cancelled = false
    const text = contentText(params?.prompt)
    textChunk(sessionId, `收到：${text.slice(0, 200)}`)

    const permission = text.match(/PERMISSION:([^\n]+)/)
    if (permission) {
      const outcome = await requestPermission(sessionId, permission[1].trim())
      const chosen = outcome.optionId ?? outcome.outcome ?? 'cancelled'
      textChunk(sessionId, `permission:${chosen}`)
      update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'call_1', title: `Run ${permission[1].trim()}`, kind: 'execute', status: outcome.optionId ? 'in_progress' : 'failed' })
    }
    if (text.includes('SLOW')) {
      await new Promise(resolve => setTimeout(resolve, 300))
    }
    if (text.includes('EXIT')) {
      setTimeout(() => process.exit(0), 20)
      return
    }
    if (session.cancelled) {
      respond(id, { stopReason: 'cancelled' })
      return
    }
    respond(id, { stopReason: 'end_turn' })
    return
  }
  respondError(id, -32601, `unknown method: ${method}`)
}

function handleNotification(message) {
  if (message.method === 'session/cancel') {
    const sessionId = String(message.params?.sessionId ?? '')
    const session = sessions.get(sessionId)
    if (session) session.cancelled = true
  }
}

process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))