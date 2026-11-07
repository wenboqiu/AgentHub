import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/index.ts'
import { createPool } from '../src/db.ts'
import { DATABASE_URL, makeUser } from './helpers.ts'

/** 一张假图：data URL 只需要前缀和 base64 合法，服务端不解码图片本身 */
const PNG = 'data:image/png;base64,' + Buffer.from('not-a-real-png-but-valid-base64').toString('base64')
/** svg 不在服务端图片白名单里，用来验证格式被拒 */
const SVG = 'data:image/svg+xml;base64,' + Buffer.from('<svg/>').toString('base64')
const pdf = (s = 'attachment body') => Buffer.from(s).toString('base64')

describe('任务附件', () => {
  const pool = createPool(DATABASE_URL)
  let app: Awaited<ReturnType<typeof buildApp>>, a: Awaited<ReturnType<typeof makeUser>>, b: typeof a
  async function call(method: string, path: string, body?: unknown, token: string = a.token) {
    const r = await app.inject({ method: method as any, url: path, headers: { authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { payload: body as any }) })
    return { status: r.statusCode, body: r.json() }
  }
  const newTask = async (title = '附件任务') => (await call('POST', '/tasks', { title })).body.task
  const addImage = (taskId: number, name = '截图.png') =>
    call('POST', `/tasks/${taskId}/attachments`, { kind: 'image', name, mime: 'image/png', data: PNG })
  const addFile = (taskId: number, name = '需求.pdf') =>
    call('POST', `/tasks/${taskId}/attachments`, { kind: 'file', name, mime: 'application/pdf', data: pdf() })

  before(async () => {
    app = await buildApp(DATABASE_URL, 'silent', { reminderIntervalMs: 100 })
    await app.listen({ port: 0, host: '127.0.0.1' })
    a = await makeUser(pool); b = await makeUser(pool)
  })
  after(async () => {
    await app.close()
    await pool.query('DELETE FROM users WHERE id=ANY($1::bigint[])', [[a.id, b.id]])
    await pool.end()
  })

  it('图片带 data URL 返回、文件只给元信息，下载都能拿到 base64', async () => {
    const t = await newTask()
    const img = await addImage(t.id), file = await addFile(t.id)
    assert.equal(img.status, 200); assert.equal(img.body.attachment.kind, 'image')
    assert.equal(img.body.attachment.url, PNG)
    assert.equal(file.status, 200); assert.equal(file.body.attachment.url, null)
    assert.equal(file.body.attachment.size, Buffer.from(pdf(), 'base64').length)
    assert.equal(file.body.attachment.name, '需求.pdf')

    const list = await call('GET', `/tasks/${t.id}/attachments`)
    assert.equal(list.status, 200)
    assert.deepEqual(list.body.attachments.map((x: any) => x.id), [img.body.attachment.id, file.body.attachment.id])
    assert.equal(list.body.attachments[0].url, PNG)
    assert.equal(list.body.attachments[1].url, null)

    const blob = await call('GET', `/tasks/${t.id}/attachments/${file.body.attachment.id}`)
    assert.equal(blob.status, 200)
    assert.equal(blob.body.name, '需求.pdf'); assert.equal(blob.body.mime, 'application/pdf')
    assert.equal(Buffer.from(blob.body.data, 'base64').toString(), 'attachment body')
    // 图片下载要剥掉 data URL 前缀，否则前端拼 Blob 会坏
    const imgBlob = await call('GET', `/tasks/${t.id}/attachments/${img.body.attachment.id}`)
    assert.ok(!imgBlob.body.data.startsWith('data:'))
  })

  it('备注只认自己的附件：别人的、不存在的 id 都拒绝', async () => {
    const t1 = await newTask('引用校验'), t2 = await newTask('另一个任务')
    const mine = (await addImage(t1.id)).body.attachment
    const other = (await addImage(t2.id)).body.attachment

    const ok = await call('PATCH', `/tasks/${t1.id}`, { notes: `看这张 ![截图](attachment:${mine.id})` })
    assert.equal(ok.status, 200)
    assert.equal(ok.body.task.notes, `看这张 ![截图](attachment:${mine.id})`)

    for (const bad of [other.id, 999999]) {
      const r = await call('PATCH', `/tasks/${t1.id}`, { notes: `![x](attachment:${bad})` })
      assert.equal(r.status, 400)
      assert.match(r.body.error, /不存在的附件/)
    }
    // 校验没过就不能改动备注
    assert.match((await call('GET', '/tasks')).body.tasks.find((x: any) => x.id === t1.id).notes, new RegExp(`attachment:${mine.id}`))
  })

  it('删附件顺手把备注里的引用摘掉，不留坏图', async () => {
    const t = await newTask('删引用')
    const img = (await addImage(t.id)).body.attachment
    const file = (await addFile(t.id)).body.attachment
    await call('PATCH', `/tasks/${t.id}`, { notes: `开头\n\n![图](attachment:${img.id})\n\n[文件](attachment:${file.id})\n结尾` })

    const r = await call('DELETE', `/tasks/${t.id}/attachments/${img.id}`)
    assert.equal(r.status, 200)
    assert.doesNotMatch(r.body.task.notes, new RegExp(`attachment:${img.id}`))
    assert.match(r.body.task.notes, new RegExp(`attachment:${file.id}`))
    assert.deepEqual(r.body.attachments.map((x: any) => x.id), [file.id])
    assert.equal((await call('GET', `/tasks/${t.id}/attachments/${img.id}`)).status, 404)
    // 再删一次：已经没了
    assert.equal((await call('DELETE', `/tasks/${t.id}/attachments/${img.id}`)).status, 404)
  })

  it('参数校验：类型、格式、base64、空内容都拒', async () => {
    const t = await newTask('校验')
    const cases: [string, Record<string, unknown>][] = [
      ['kind', { kind: 'video', name: 'x', mime: 'video/mp4', data: pdf() }],
      ['图片格式', { kind: 'image', name: 'x.svg', mime: 'image/svg+xml', data: SVG }],
      ['图片内容', { kind: 'image', name: 'x.png', mime: 'image/png', data: 'aGVsbG8=' }],
      ['文件名', { kind: 'file', name: '', mime: 'application/pdf', data: pdf() }],
      ['空内容', { kind: 'file', name: 'x.pdf', mime: 'application/pdf', data: '' }],
      ['base64', { kind: 'file', name: 'x.pdf', mime: 'application/pdf', data: '不是 base64!!' }],
      ['缺类型', { kind: 'file', name: 'x.pdf', mime: '', data: pdf() }],
    ]
    for (const [label, body] of cases) {
      const r = await call('POST', `/tasks/${t.id}/attachments`, body)
      assert.equal(r.status, 400, label)
    }
    assert.equal((await call('POST', `/tasks/${t.id}/attachments`, { kind: 'file', name: 'x.pdf', mime: 'application/pdf', data: pdf() }, b.token)).status, 404)
    assert.equal((await call('GET', `/tasks/${t.id}/attachments`, undefined, b.token)).status, 404)
  })

  it('跨账号看不到也删不掉别人任务的附件', async () => {
    const t = await newTask('隔离')
    const id = (await addImage(t.id)).body.attachment.id
    assert.equal((await call('GET', `/tasks/${t.id}/attachments/${id}`, undefined, b.token)).status, 404)
    assert.equal((await call('DELETE', `/tasks/${t.id}/attachments/${id}`, undefined, b.token)).status, 404)
    assert.equal((await call('GET', `/tasks/${t.id}/attachments/${id}`)).status, 200)
  })
})
