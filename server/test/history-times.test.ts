import {after,before,describe,it} from 'node:test'
import assert from 'node:assert/strict'
import {createPool,historyTimes,listActivity,listMessages,replaceHistory} from '../src/db.ts'
import {DATABASE_URL,makeUser} from './helpers.ts'

const MINUTE=60_000
const iso=(t:number)=>new Date(t).toISOString()

describe('历史快照的时间戳',()=>{
  it('有原始时间就用原始时间，不被挤成同一瞬间',()=>{
    const items=[{at:Date.parse('2026-11-02T01:10:00Z'),sourceId:'a'},{at:Date.parse('2026-11-02T01:35:00Z'),sourceId:'b'}]
    const times=historyTimes(items,new Map(),Date.parse('2026-11-02T02:00:00Z'))
    assert.equal(iso(times[0]),'2026-11-02T01:10:00.000Z')
    assert.equal(iso(times[1]),'2026-11-02T01:35:00.000Z')
  })
  it('老电脑端不带时间时沿用库里原时间，未知的按前后插值',()=>{
    const prev=new Map([['a',Date.parse('2026-11-02T01:00:00Z')],['c',Date.parse('2026-11-02T03:00:00Z')]])
    const items=[{at:null,sourceId:'a'},{at:null,sourceId:'b'},{at:null,sourceId:'c'},{at:null,sourceId:'d'}]
    const times=historyTimes(items,prev,Date.parse('2026-11-02T04:00:00Z'))
    assert.equal(iso(times[0]),'2026-11-02T01:00:00.000Z')
    assert.equal(iso(times[1]),'2026-11-02T02:00:00.000Z')
    assert.equal(iso(times[2]),'2026-11-02T03:00:00.000Z')
    assert.equal(iso(times[3]),'2026-11-02T03:01:00.000Z')
  })
  it('完全没有时间戳时保持顺序，不越过当前时间',()=>{
    const now=Date.now()
    const times=historyTimes([{at:null,sourceId:null},{at:null,sourceId:null},{at:null,sourceId:null}],new Map(),now)
    assert.ok(times.every(t=>t<=now))
    assert.ok(times[0]<times[1]&&times[1]<times[2])
  })
  it('时间倒挂时按顺序拉开 1 毫秒',()=>{
    const items=[{at:Date.parse('2026-11-02T05:00:00Z'),sourceId:'a'},{at:Date.parse('2026-11-02T04:00:00Z'),sourceId:'b'}]
    const times=historyTimes(items,new Map(),Date.parse('2026-11-02T06:00:00Z'))
    assert.ok(times[0]<times[1])
  })

  describe('落库后活动分布',()=>{
    const pool=createPool(DATABASE_URL)
    let user:Awaited<ReturnType<typeof makeUser>>
    const sid=`codex:history-time-${Date.now()}`
    before(async()=>{user=await makeUser(pool)})
    after(async()=>{await pool.query('DELETE FROM messages WHERE user_id=$1',[user.id]);await pool.query('DELETE FROM users WHERE id=$1',[user.id]);await pool.end()})

    it('两小时的对话不会被压成 5 分钟',async()=>{
      await replaceHistory(pool,user.id,sid,[
        {role:'user',text:'开始',sourceId:'m1',at:'2026-11-02T09:10:00+08:00'},
        {role:'assistant',text:'一',sourceId:'m2',at:'2026-11-02T09:50:00+08:00'},
        {role:'assistant',text:'二',sourceId:'m3',at:'2026-11-02T11:00:00+08:00'},
      ])
      const list=await listMessages(pool,user.id,sid,10)
      assert.equal(list[0].createdAt,'2026-11-02T01:10:00.000Z')
      assert.equal(list[2].createdAt,'2026-11-02T03:00:00.000Z')
      const buckets=(await listActivity(pool,user.id,new Date('2026-11-02T00:00:00Z'),new Date('2026-11-03T00:00:00Z'))).filter(b=>b.sessionId===sid)
      assert.equal(buckets.length,3)
    })

    it('再次同步时老客户端不带 at 也保留原来的时间',async()=>{
      await replaceHistory(pool,user.id,sid,[
        {role:'user',text:'开始',sourceId:'m1'},
        {role:'assistant',text:'一',sourceId:'m2'},
        {role:'assistant',text:'二',sourceId:'m3'},
      ])
      const list=await listMessages(pool,user.id,sid,10)
      assert.equal(list[0].createdAt,'2026-11-02T01:10:00.000Z')
      assert.equal(list[2].createdAt,'2026-11-02T03:00:00.000Z')
    })
  })
})
