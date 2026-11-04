import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { buildApp } from '../src/index.ts'
import { DATABASE_URL, makeUser } from './helpers.ts'

// WorkBuddy 只读 transcript、没有消息同步：活动桶随 /events 顺路上报，
// 服务端落 session_activity，日历 /activity 才有数据画对话跨度。
describe('事件携带活动桶', () => {
  const pool = new pg.Pool({connectionString:DATABASE_URL,max:2})
  let app: Awaited<ReturnType<typeof buildApp>>
  let token = '', other = '', n = 0
  const prefix = `bk-${Date.now()}`
  const at = new Date(Date.now()-60_000).toISOString()
  const b1 = new Date(Date.now()-10*60_000).toISOString()
  const b2 = new Date(Date.now()-5*60_000).toISOString()
  const event = (sessionId:string, extra:Record<string,unknown>={}) => ({agent:'workbuddy',sessionId,machine:'pc',cwd:'D:/project',state:'done',title:'标题',at,...extra})
  const send = (events:unknown[], auth=token) => app.inject({method:'POST',url:'/events',headers:{authorization:`Bearer ${auth}`},payload:{events}})
  async function buckets(s:string) {
    const from = new Date(Date.now()-24*3600_000).toISOString()
    const to = new Date().toISOString()
    const r = await app.inject({method:'GET',url:`/activity?from=${from}&to=${to}`,headers:{authorization:`Bearer ${token}`}})
    return r.json().activity.filter((row:any)=>row.sessionId===`workbuddy:${s}`)
  }
  before(async()=>{
    app=await buildApp(DATABASE_URL,'silent',{})
    token=(await makeUser(pool)).token;other=(await makeUser(pool)).token
  })
  after(async()=>{await app.close();await pool.end()})

  it('活动桶落库并在 /activity 可查',async()=>{
    const s=`${prefix}-${n++}`
    assert.equal((await send([event(s,{buckets:[{at:b1,count:3},{at:b2,count:1}]})])).json().accepted,1)
    const rows=await buckets(s)
    assert.equal(rows.length,2)
    assert.deepEqual(rows.map((r:any)=>r.count).sort((a:number,b:number)=>b-a),[3,1])
  })

  it('同桶重复上报取更大计数，真实消息的桶不被覆盖',async()=>{
    const s=`${prefix}-${n++}`
    await send([event(s,{buckets:[{at:b1,count:2}]})])
    await send([event(s,{at:new Date().toISOString(),buckets:[{at:b1,count:5},{at:b2,count:1}]})])
    const rows=await buckets(s)
    assert.equal(rows.find((r:any)=>r.at.startsWith(b1.slice(0,13)))?.count,5,'同桶应取更大者')
  })

  it('非法桶整批拒绝，不带 buckets 的事件照常入库',async()=>{
    const s=`${prefix}-${n++}`
    assert.equal((await send([event(s,{buckets:[{at:'nope'}]})])).statusCode,400)
    assert.equal((await send([event(s,{buckets:'x'})])).statusCode,400)
    assert.equal((await send([event(s)])).json().accepted,1)
    assert.equal((await buckets(s)).length,0)
  })
})
