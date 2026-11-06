import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/index.ts'
import { createPool, insertMessage, listMessages } from '../src/db.ts'
import { DATABASE_URL, makeUser } from './helpers.ts'

/**
 * WorkBuddy 只读监听：正文只在电脑上的 transcript 里，服务端库里的记录会落后。
 * 跑完一轮时必须「先同步正文，再攒任务单」——顺序反了，界面上就是任务单先冒出来、
 * 最新回复还停在上一轮，任务单的标题也会从旧回复里摘。
 */

let TOKEN = ''
let USER_ID = 0
const stamp = Date.now()
let n = 0
const uniq = (p: string) => `${p}${stamp}-${n++}`
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function waitFor<T>(fn: () => T | undefined | null | false, ms = 4000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > end) throw new Error('waitFor 超时')
    await sleep(20)
  }
}

describe('WorkBuddy 正文先同步再攒任务单', () => {
  const pool = createPool(DATABASE_URL)
  let app: FastifyInstance
  let base = ''
  const socks: WebSocket[] = []

  async function call(method: string, path: string, body?: unknown) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        Authorization: `Bearer ${TOKEN}`,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    return { status: res.status, body: (text.startsWith('{') ? JSON.parse(text) : text) as any }
  }

  type Peer = { ws: WebSocket; msgs: any[] }
  async function connect(query: string): Promise<Peer> {
    const ws = new WebSocket(base.replace('http', 'ws') + `/ws?token=${TOKEN}&${query}`)
    const p: Peer = { ws, msgs: [] }
    ws.onmessage = e => p.msgs.push(JSON.parse(String(e.data)))
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error('ws error'))
    })
    socks.push(ws)
    return p
  }

  before(async () => {
    app = await buildApp(DATABASE_URL, 'silent', { historyTimeoutMs: 3000 })
    base = await app.listen({ port: 0, host: '127.0.0.1' })
    const u = await makeUser(pool)
    TOKEN = u.token
    USER_ID = u.id
  })
  after(async () => {
    for (const s of socks) s.close()
    await app.close()
    await pool.end()
  })

  it('完成时先把电脑上的正文写进库，再按最新回复攒任务单', async () => {
    const machine = uniq('pc')
    const ex = await connect(`role=agent&machine=${machine}`)
    const viewer = await connect('')
    await waitFor(() => viewer.msgs.find(m => m.type === 'snapshot'))
    await waitFor(async () => (await call('GET', '/control/status')).body.agents.includes(machine))

    const key = uniq('wb')
    const id = `workbuddy:${key}`
    await call('POST', '/events', {
      events: [{ agent: 'workbuddy', sessionId: key, machine, cwd: 'D:\\Work2\\Demo', state: 'running', title: '整理农场场景', at: new Date(Date.now() - 60_000).toISOString() }],
    })
    // 库里只留下上一轮：这一轮的正文还在电脑上
    await insertMessage(pool, USER_ID, id, null, 'assistant', '上一轮的结论：先把麦田补齐，其它以后再说。')

    const doneAt = new Date().toISOString()
    await call('POST', '/events', {
      events: [{ agent: 'workbuddy', sessionId: key, machine, cwd: 'D:\\Work2\\Demo', state: 'done', title: '整理农场场景', at: doneAt }],
    })

    // 服务端应当先向电脑端要这一轮的正文
    const req = await waitFor(() => ex.msgs.find(m => m.type === 'history.request'))
    const latest = '这一轮已经补完麦田与石砖烤炉，风车也换成了低模。\n下一步：把南瓜菜园的贴图换成同色系，再跑一遍场景截图。'
    ex.ws.send(JSON.stringify({
      type: 'history.result',
      requestId: req.requestId,
      messages: [
        { role: 'user', text: '把农场场景补完' },
        { role: 'assistant', text: latest, at: doneAt },
      ],
    }))

    // 正文同步完成 → 通知界面重载；随后才轮到任务单
    await waitFor(() => viewer.msgs.find(m => m.type === 'session.history' && m.sessionId === id))
    const proposal = await waitFor(() => viewer.msgs.find(m => m.type === 'proposal' && m.proposal.sessionId === id))
    const histIdx = viewer.msgs.findIndex(m => m.type === 'session.history' && m.sessionId === id)
    const propIdx = viewer.msgs.findIndex(m => m.type === 'proposal' && m.proposal.sessionId === id)
    assert.ok(histIdx < propIdx, '正文同步要排在任务单之前')

    // 库里已经是这一轮的内容
    const rows = await listMessages(pool, USER_ID, id, 200)
    assert.equal(rows.at(-1)?.text, latest)

    // 任务单标题摘自最新回复里那句「下一步」，不是上一轮
    assert.match(proposal.proposal.title, /南瓜菜园/)
  })
})
