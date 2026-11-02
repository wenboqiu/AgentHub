import {after,before,describe,it} from 'node:test'
import assert from 'node:assert/strict'
import {buildApp} from '../src/index.ts'
import {createPool,insertMessage,listMessages,replaceHistory} from '../src/db.ts'
import {DATABASE_URL,makeUser} from './helpers.ts'

describe('回复评价与指定节点分支',()=>{
  const pool=createPool(DATABASE_URL)
  let app:Awaited<ReturnType<typeof buildApp>>,base='',user:Awaited<ReturnType<typeof makeUser>>,other:Awaited<ReturnType<typeof makeUser>>
  let ex:WebSocket
  const frames:any[]=[]
  const machine=`reply-pc-${Date.now()}`, key=`reply-session-${Date.now()}`, sid=`codex:${key}`
  const call=async(method:string,path:string,body?:unknown,token=user.token)=>{
    const r=await fetch(base+path,{method,headers:{Authorization:`Bearer ${token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)})
    return {status:r.status,body:await r.json() as any}
  }
  const wait=async(fn:()=>any)=>{for(let i=0;i<200;i++){const v=fn();if(v)return v;await new Promise(r=>setTimeout(r,10))}throw Error('executor timeout')}
  before(async()=>{
    app=await buildApp(DATABASE_URL,'silent',{});base=await app.listen({host:'127.0.0.1',port:0})
    user=await makeUser(pool);other=await makeUser(pool)
    ex=new WebSocket(base.replace('http','ws')+`/ws?role=agent&capabilities=reply-branch-v1&machine=${machine}&token=${user.token}`)
    ex.onmessage=e=>frames.push(JSON.parse(String(e.data)))
    await new Promise<void>((resolve,reject)=>{ex.onopen=()=>resolve();ex.onerror=()=>reject(Error('ws'))})
    await call('POST','/events',{events:[{agent:'codex',sessionId:key,machine,cwd:'D:/project',state:'done',at:new Date().toISOString()}]})
  })
  after(async()=>{ex?.close();await app?.close();if(user)await pool.query('DELETE FROM users WHERE id IN ($1,$2)',[user.id,other.id]);await pool.end()})
  const feedback=(id:number)=>`/sessions/${sid}/messages/${id}/feedback`
  it('评价按原始消息标识保存，刷新改编号后保留，重复文本不混淆并按账号隔离',async()=>{
    const a=await insertMessage(pool,user.id,sid,null,'assistant','相同的回答',{sourceId:'message-a',branchPoint:'turn-a'})
    const b=await insertMessage(pool,user.id,sid,null,'assistant','相同的回答',{sourceId:'message-b',branchPoint:'turn-b'})
    assert.equal((await call('PATCH',feedback(a.id),{rating:'up'})).status,200)
    let list=await listMessages(pool,user.id,sid,200)
    assert.equal(list.find(m=>m.id===a.id)?.rating,'up');assert.equal(list.find(m=>m.id===b.id)?.rating,null)
    assert.equal((await call('PATCH',feedback(a.id),{rating:'down'},other.token)).status,404)
    assert.equal((await call('PATCH',feedback(a.id),{rating:'bad'})).status,400)
    await replaceHistory(pool,user.id,sid,[{role:'assistant',text:a.text,sourceId:'message-a',branchPoint:'turn-a'},{role:'assistant',text:b.text,sourceId:'message-b',branchPoint:'turn-b'}])
    list=await listMessages(pool,user.id,sid,200)
    assert.equal(list[0].rating,'up');assert.notEqual(list[0].id,a.id)
    assert.equal((await call('PATCH',feedback(list[0].id),{rating:'down'})).body.message.rating,'down')
    assert.equal((await call('PATCH',feedback(list[0].id),{rating:null})).body.message.rating,null)
    const old=await insertMessage(pool,user.id,sid,null,'assistant','legacy')
    assert.equal((await call('PATCH',feedback(old.id),{rating:'up'})).status,409)
  })
  it('分支只发送所选回复的节点，拒绝伪造、未完成和不属于会话的消息',async()=>{
    const a=await insertMessage(pool,user.id,sid,null,'assistant','早期回答',{sourceId:'early',branchPoint:'turn-early'})
    await insertMessage(pool,user.id,sid,null,'assistant','最新回答',{sourceId:'later',branchPoint:'turn-later'})
    const path=`/sessions/${sid}/spawn`
    const r=await call('POST',path,{mode:'fork',text:'尝试另一种方案',messageId:a.id,branchPoint:'turn-later'})
    assert.equal(r.status,200)
    const start=await wait(()=>frames.find(m=>m.type==='run.start' && m.runId===r.body.runId))
    assert.equal(start.branchPoint,'turn-early');assert.equal(start.sessionKey,key);assert.equal(start.mode,'fork')
    assert.equal((await call('POST',path,{mode:'fork',text:'x',messageId:a.id},other.token)).status,404)
    assert.equal((await call('POST',path,{mode:'fresh',text:'x',messageId:a.id})).status,400)
    const legacy=await insertMessage(pool,user.id,sid,null,'assistant','没有原始节点')
    assert.equal((await call('POST',path,{mode:'fork',text:'x',messageId:legacy.id})).status,409)
    const wrong=await insertMessage(pool,user.id,'codex:another',null,'assistant','other',{sourceId:'wrong',branchPoint:'wrong-turn'})
    assert.equal((await call('POST',path,{mode:'fork',text:'x',messageId:wrong.id})).status,404)
    await call('POST','/events',{events:[{agent:'codex',sessionId:key,machine,cwd:'D:/project',state:'running',at:new Date().toISOString()}]})
    assert.equal((await call('POST',path,{mode:'fork',text:'x',messageId:a.id})).status,409)
  })
  it('历史同步保留原始消息与节点；缺失/非法元数据保持不可分支',async()=>{
    const request=call('POST',`/sessions/${sid}/history`)
    const start=await wait(()=>frames.find(m=>m.type==='history.request'))
    ex.send(JSON.stringify({type:'history.result',requestId:start.requestId,messages:[{role:'assistant',text:'stored',sourceId:'native-id',branchPoint:'native-turn'},{role:'assistant',text:'bad',sourceId:'../bad',branchPoint:'../bad'}]}))
    const result=await request
    assert.equal(result.status,200)
    assert.equal(result.body.messages[0].sourceId,'native-id');assert.equal(result.body.messages[0].branchPoint,'native-turn')
    assert.equal(result.body.messages[1].sourceId,undefined);assert.equal(result.body.messages[1].branchPoint,undefined)
  })
  it('旧电脑端不支持节点参数时拒绝分支，避免静默复制整个会话',async()=>{
    const legacyMachine=machine+'-old', legacyId='legacy-'+key, legacySid='codex:'+legacyId
    await call('POST','/events',{events:[{agent:'codex',sessionId:legacyId,machine:legacyMachine,cwd:'D:/project',state:'done',at:new Date().toISOString()}]})
    const old=new WebSocket(base.replace('http','ws')+`/ws?role=agent&machine=${legacyMachine}&token=${user.token}`)
    try{
      await new Promise<void>((resolve,reject)=>{old.onopen=()=>resolve();old.onerror=()=>reject(Error('ws'))})
      for(let i=0;i<100;i++){if((await call('GET','/control/status')).body.agents.includes(legacyMachine))break;await new Promise(r=>setTimeout(r,10))}
      const m=await insertMessage(pool,user.id,legacySid,null,'assistant','old host reply',{sourceId:'legacy-source',branchPoint:'legacy-turn'})
      const r=await call('POST',`/sessions/${legacySid}/spawn`,{mode:'fork',text:'x',messageId:m.id})
      assert.equal(r.status,409);assert.match(r.body.error,/更新电脑端/)
    }finally{old.close()}
  })
})
