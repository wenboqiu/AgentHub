import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { buildApp } from '../src/index.ts'
import { DATABASE_URL, makeUser } from './helpers.ts'

describe('WorkBuddy 已读同步', () => {
  const pool = new pg.Pool({connectionString:DATABASE_URL,max:2})
  let app: Awaited<ReturnType<typeof buildApp>>
  let token = '', other = '', n = 0
  const prefix = `wb-read-${Date.now()}`
  const at = new Date(Date.now()-60_000).toISOString()
  const later = new Date(Date.parse(at)+10_000).toISOString()
  const readAt = new Date().toISOString()
  const event = (sessionId:string, extra:Record<string,unknown>={}) => ({agent:'workbuddy',sessionId,machine:'pc',cwd:'/w/project',state:'done',title:'标题',at,...extra})
  const send = (events:unknown[], auth=token) => app.inject({method:'POST',url:'/events',headers:{authorization:`Bearer ${auth}`},payload:{events}})
  const receipt = (s:string, extra:Record<string,unknown>={}) => event(s,{quiet:true,expectedAt:at,readAt,...extra})
  async function get(s:string) {
    const result=await app.inject({method:'GET',url:'/sessions?all=1',headers:{authorization:`Bearer ${token}`}})
    return result.json().sessions.find((row:any)=>row.id===`workbuddy:${s}`)
  }
  before(async()=>{
    app=await buildApp(DATABASE_URL,'silent',{})
    token=(await makeUser(pool)).token;other=(await makeUser(pool)).token
  })
  after(async()=>{await app.close();await pool.end()})

  it('在 WorkBuddy 里读完回复后，待处理被清除且状态内容不变',async()=>{
    const s=`${prefix}-${n++}`
    await send([event(s,{summary:'已完成'})]);assert.equal((await get(s)).acked,false)
    assert.equal((await send([receipt(s)])).json().accepted,1)
    const row=await get(s)
    assert.equal(row.acked,true);assert.equal(row.state,'done');assert.equal(row.summary,'已完成');assert.equal(row.eventAt,at);assert.equal(row.title,'标题')
  })
  it('旧回执不能清除新回复、待授权或另一台电脑的状态',async()=>{
    const s=`${prefix}-${n++}`
    await send([event(s)])
    for(const extra of [{machine:'other'},{quiet:false},{expectedAt:undefined},{readAt:new Date(Date.parse(at)-1).toISOString()}]) {
      assert.equal((await send([receipt(s,extra)])).json().accepted,0)
      assert.equal((await get(s)).acked,false)
    }
    await send([event(s,{at:later})])
    assert.equal((await send([receipt(s)])).json().accepted,0)
    assert.equal((await get(s)).acked,false)
    await send([event(s,{state:'waiting',at:later})])
    assert.equal((await send([receipt(s,{state:'waiting',at:later,expectedAt:later})])).json().accepted,0)
    assert.equal((await get(s)).acked,false)
  })
  it('只有能读到本机已读存储的 agent 才能回执',async()=>{
    const s=`${prefix}-${n++}`
    const rows=async()=>(await app.inject({method:'GET',url:'/sessions?all=1',headers:{authorization:`Bearer ${token}`}})).json().sessions
    await send([{...event(s),agent:'doubao'}])
    assert.equal((await send([{...receipt(s),agent:'doubao'}])).json().accepted,0)
    assert.equal((await rows()).find((r:any)=>r.id===`doubao:${s}`).acked,false)
  })
  it('重复完成事件不重新提醒，真正的新完成仍待处理',async()=>{
    const s=`${prefix}-${n++}`
    await send([event(s)]);await send([receipt(s)])
    await send([event(s)]);assert.equal((await get(s)).acked,true)
    await send([event(s,{at:later})]);assert.equal((await get(s)).acked,false)
  })
  it('回执不可跨账号确认，非法日期拒绝',async()=>{
    const s=`${prefix}-${n++}`
    await send([event(s)])
    assert.equal((await send([receipt(s)],other)).json().accepted,0)
    assert.equal((await get(s)).acked,false)
    assert.equal((await send([receipt(s,{readAt:'invalid'})])).statusCode,400)
  })
})
