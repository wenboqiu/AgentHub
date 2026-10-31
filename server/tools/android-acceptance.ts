// 本地真机验收夹具：真实 API/数据库/WS + 模拟执行器，不启动 Claude/Codex。
// 仅监听 loopback；通过 adb reverse tcp:47831 tcp:47831 给调试 APK 使用。
import pg from 'pg'
import { buildApp } from '../src/index.ts'
import { hashPassword } from '../src/auth.ts'

const url = process.env.DATABASE_URL ?? 'postgres://postgres:dev@localhost:55433/agenthub'
const admin = new pg.Pool({ connectionString: url })
const schema = `acceptance_${Date.now()}`
await admin.query(`CREATE SCHEMA ${schema}`)
const isolated = new URL(url)
isolated.searchParams.set('options', `-c search_path=${schema}`)
const app = await buildApp(isolated.toString(), 'silent', {})
// 隔离 schema 里直接插一个账号；listen 之后再走 /auth/login 拿设备会话 token，执行器和 viewer 都用它
const email = 'acceptance@test.dev'
const password = 'acceptance-pass'
await admin.query(`INSERT INTO ${schema}.users (email, password_hash) VALUES ($1, $2)`, [email, await hashPassword(password)])
const viewers = new Set<any>()
app.websocketServer.on('connection', (socket, request) => {
  if (!request.url?.includes('role=agent')) {
    viewers.add(socket)
    socket.on('close', () => viewers.delete(socket))
  }
})
let executor: WebSocket
let currentRun = ''
let approvalId = ''
const decisions: string[] = []
const emit = (value: unknown) => executor.send(JSON.stringify(value))
app.post('/__acceptance/action', async request => {
  const { action } = request.body as { action: string }
  if (action === 'disconnect-complete') {
    for (const socket of viewers) socket.terminate()
    emit({ type: 'run.message', runId: currentRun, role: 'assistant', text: 'RECONNECTED: message received while offline' })
    emit({ type: 'run.status', runId: currentRun, status: 'done' })
  } else if (action === 'expire') {
    emit({ type: 'run.approvalExpired', runId: currentRun, approvalId })
    emit({ type: 'run.message', runId: currentRun, role: 'system', text: 'EXPIRED: approval timed out; run continues' })
  }
  return { currentRun, approvalId, decisions }
})
const base = await app.listen({ port: Number(process.env.ACCEPTANCE_PORT) || 47831, host: '127.0.0.1' })
const login = await fetch(base + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, device: 'acceptance' }) })
if (!login.ok) throw new Error(`登录失败：${login.status}`)
const { token } = (await login.json()) as { token: string }
executor = new WebSocket(base.replace('http', 'ws') + `/ws?token=${token}&role=agent&machine=AcceptancePC`)
executor.onmessage = event => {
  const m = JSON.parse(String(event.data))
  if (m.type === 'run.start') {
    currentRun = m.runId
    emit({ type: 'run.status', runId: currentRun, status: 'running' })
    emit({ type: 'run.message', runId: currentRun, role: 'assistant', text: 'RUNNING: waiting for acceptance action' })
    if (m.text.includes('approval')) emit({ type: 'run.approval', runId: currentRun, localId: Date.now(), tool: 'Write', detail: 'Acceptance fixture: sample.txt' })
  } else if (m.type === 'approval.created') approvalId = m.approvalId
  else if (m.type === 'approval.decide') {
    decisions.push(m.decision)
    emit({ type: 'run.message', runId: currentRun, role: 'system', text: `DECISION: ${m.decision}` })
  } else if (m.type === 'run.stop') emit({ type: 'run.status', runId: m.runId, status: 'stopped' })
  else if (m.type === 'history.request') emit({ type: 'history.result', requestId: m.requestId, messages: [{ role: 'user', text: 'HISTORY: earlier question' }, { role: 'assistant', text: 'HISTORY: earlier answer' }] })
}
await new Promise<void>((resolve, reject) => { executor.onopen = () => resolve(); executor.onerror = reject })
await fetch(base + '/events', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ events: [{ agent: 'claude', sessionId: 'android-acceptance', machine: 'AcceptancePC', cwd: 'D:\\Acceptance', title: 'Android acceptance (simulated executor)', state: 'done', at: new Date().toISOString(), quiet: true }] }) })
console.log(JSON.stringify({ base, schema, email, password, session: 'claude:android-acceptance' }))
let closing = false
async function close() {
  if (closing) return
  closing = true
  executor.close()
  await app.close()
  await admin.query(`DROP SCHEMA ${schema} CASCADE`)
  await admin.end()
  process.exit(0)
}
process.on('SIGINT', close)
process.on('SIGTERM', close)
