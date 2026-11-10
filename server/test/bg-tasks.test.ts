import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { buildApp } from '../src/index.ts'
import { DATABASE_URL, makeUser } from './helpers.ts'

// Claude Stop hook 时主对话结束但还有后台子代理：running 事件带 bgTasks，其它状态恒为 0
describe('会话后台任务数', () => {
  const pool = new pg.Pool({connectionString:DATABASE_URL,max:2})
  let app: Awaited<ReturnType<typeof buildApp>>
  let token = ''
  const sid = `bg-${Date.now()}`
  const t0 = Date.now()-60_000
  const event = (state:string, offset:number, extra:Record<string,unknown>={}) =>
    ({agent:'claude',sessionId:sid,machine:'pc',cwd:'D:/project',state,at:new Date(t0+offset).toISOString(),...extra})
  const send = (events:unknown[]) => app.inject({method:'POST',url:'/events',headers:{authorization:`Bearer ${token}`},payload:{events}})
  async function bgTasks() {
    const r = await app.inject({method:'GET',url:'/sessions',headers:{authorization:`Bearer ${token}`}})
    return r.json().sessions.find((s:any)=>s.id===`claude:${sid}`)?.bgTasks
  }
  before(async()=>{
    app=await buildApp(DATABASE_URL,'silent',{})
    token=(await makeUser(pool)).token
  })
  after(async()=>{await app.close();await pool.end()})

  it('running 带 bgTasks 落库，之后 done 清零',async()=>{
    assert.equal((await send([event('running',0,{bgTasks:2})])).json().accepted,1)
    assert.equal(await bgTasks(),2)
    assert.equal((await send([event('done',1000)])).json().accepted,1)
    assert.equal(await bgTasks(),0)
  })

  it('非 running 状态即使带 bgTasks 也记 0，非法值记 0',async()=>{
    await send([event('done',2000,{bgTasks:3})])
    assert.equal(await bgTasks(),0)
    await send([event('running',3000,{bgTasks:-5})])
    assert.equal(await bgTasks(),0)
    await send([event('running',4000,{bgTasks:500})])
    assert.equal(await bgTasks(),99)
  })
})
