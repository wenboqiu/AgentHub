import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { buildApp } from '../src/index.ts'
import { createPool, migrate } from '../src/db.ts'
import { collectReminders, listReminders } from '../src/reminders.ts'
import { syncTaskForSession } from '../src/tasks.ts'
import { DATABASE_URL, makeUser } from './helpers.ts'

describe('目标与任务', () => {
  const pool=createPool(DATABASE_URL)
  let app: Awaited<ReturnType<typeof buildApp>>, base:string, a:Awaited<ReturnType<typeof makeUser>>, b:typeof a
  const peers:WebSocket[]=[]
  async function call(method:string,path:string,body?:unknown,token=a.token) {
    const r=await app.inject({method:method as any,url:path,headers:{authorization:`Bearer ${token}`},...(body===undefined?{}:{payload:body as any})})
    return {status:r.statusCode,body:r.json()}
  }
  async function wait<T>(fn:()=>T|undefined|false) {
    const until=Date.now()+4000
    for(;;){const r=fn();if(r)return r;if(Date.now()>until)throw new Error('等待广播超时');await new Promise(r=>setTimeout(r,10));}
  }
  async function connect(query='',token=a.token) {
    const ws=new WebSocket(`${base.replace('http','ws')}/ws?token=${token}&${query}`), msgs:any[]=[]
    ws.onmessage=e=>msgs.push(JSON.parse(String(e.data)));peers.push(ws)
    await new Promise<void>((ok,fail)=>{ws.onopen=()=>ok();ws.onerror=()=>fail(new Error('连接失败'));})
    if(!query)await wait(()=>msgs.find(m=>m.type==='snapshot'))
    else await waitAsync(async()=>((await call('GET','/control/status',undefined,token)).body.agents.includes(new URLSearchParams(query).get('machine'))))
    return {ws,msgs}
  }
  async function waitAsync(fn:()=>Promise<boolean>) {const end=Date.now()+4000;while(!await fn()){if(Date.now()>end)throw new Error('超时');await new Promise(r=>setTimeout(r,10));}}
  const newTask=async(body:Record<string,unknown>={})=>(await call('POST','/tasks',{title:'测试任务',...body})).body.task
  const get=async(id:number)=>(await call('GET','/tasks')).body.tasks.find((t:any)=>t.id===id)
  async function session(state='running',token=a.token,key:string=randomUUID()) {
    assert.equal((await call('POST','/events',{events:[{agent:'claude',sessionId:key,machine:'任务测试机',cwd:'D:\\TaskTest',state,at:new Date().toISOString()}]},token)).status,200)
    return `claude:${key}`
  }
  before(async()=>{app=await buildApp(DATABASE_URL,'silent',{reminderIntervalMs:100});base=await app.listen({port:0,host:'127.0.0.1'});a=await makeUser(pool);b=await makeUser(pool);})
  after(async()=>{for(const ws of peers)ws.close();await app.close();await pool.query('DELETE FROM users WHERE id=ANY($1::bigint[])',[[a.id,b.id]]);await pool.end();})

  it('目标与普通任务 CRUD、清洗、完成时间、删除目标保留任务',async()=>{
    const g=(await call('POST','/goals',{title:' \0目标 ',notes:' 说明\0 '})).body.goal
    assert.equal(g.title,'目标');assert.equal(g.notes,'说明')
    let t=await newTask({goalId:g.id,notes:' 备注\0 '});assert.equal(t.notes,'备注');assert.deepEqual(t.sessionIds,[])
    t=(await call('PATCH',`/tasks/${t.id}`,{status:'done'})).body.task;assert.ok(t.doneAt)
    t=(await call('PATCH',`/tasks/${t.id}`,{status:'todo'})).body.task;assert.equal(t.doneAt,null)
    assert.equal((await call('PATCH',`/goals/${g.id}`,{status:'archived',title:'新目标'})).body.goal.status,'archived')
    assert.equal((await call('DELETE',`/goals/${g.id}`)).status,200);assert.equal((await get(t.id)).goalId,null)
    assert.equal((await call('DELETE',`/tasks/${t.id}`)).status,200);assert.equal(await get(t.id),undefined)
  })
  it('字段校验、账号隔离、禁止跨账号关联目标和会话',async()=>{
    for(const title of ['', ' '.repeat(2), 'x'.repeat(201), '\0'])assert.equal((await call('POST','/tasks',{title})).status,400)
    for(const body of [{title:'x',agent:'bad'},{title:'x',notes:42},{title:'x',cwd:5},{title:'x',notes:'x'.repeat(4001)}])assert.equal((await call('POST','/tasks',body)).status,400)
    const g=(await call('POST','/goals',{title:'隔离'})).body.goal,t=await newTask()
    for(const [kind,id] of [['goals',g.id],['tasks',t.id]] as const)for(const method of ['PATCH','DELETE'])assert.equal((await call(method,`/${kind}/${id}`,method==='PATCH'?{title:'偷改'}:undefined,b.token)).status,404)
    assert.equal((await call('POST','/tasks',{title:'跨账号',goalId:g.id},b.token)).status,404)
    assert.equal((await call('PATCH',`/tasks/${t.id}`,{status:'bad'})).status,400)
    assert.equal((await call('PATCH',`/goals/${g.id}`,{status:'bad'})).status,400)
    const sid=await session('running',b.token)
    assert.equal((await call('POST',`/tasks/${t.id}/sessions`,{sessionId:sid})).status,404)
    assert.equal((await call('GET','/tasks',undefined,b.token)).body.tasks.length,0)
    assert.equal((await call('GET','/goals',undefined,b.token)).body.goals.length,0)
    assert.equal((await call('POST',`/tasks/${t.id}/start`,{},b.token)).status,404)
  })
  it('目标优先级默认中，创建、修改与重新读取保留设置，拒绝非法值',async()=>{
    const g=(await call('POST','/goals',{title:'默认优先级'})).body.goal
    assert.equal(g.priority,'medium')
    for(const priority of ['high','medium','low']) {
      const created=await call('POST','/goals',{title:`优先级 ${priority}`,priority})
      assert.equal(created.status,200);assert.equal(created.body.goal.priority,priority)
      const updated=await call('PATCH',`/goals/${g.id}`,{priority})
      assert.equal(updated.status,200);assert.equal(updated.body.goal.priority,priority)
      assert.equal((await call('PATCH',`/goals/${g.id}`,{notes:'保留优先级'})).body.goal.priority,priority)
      assert.equal((await call('GET','/goals')).body.goals.find((row:any)=>row.id===g.id).priority,priority)
    }
    for(const priority of ['urgent','',null,1,[],{}]) {
      assert.equal((await call('POST','/goals',{title:'非法优先级',priority})).status,400)
      assert.equal((await call('PATCH',`/goals/${g.id}`,{priority})).status,400)
    }
    assert.equal((await call('PATCH',`/goals/${g.id}`,{priority:'high'},b.token)).status,404)
    assert.equal((await call('GET','/goals')).body.goals.find((row:any)=>row.id===g.id).priority,'low')
  })
  it('挂接幂等、清理会话后保留关系、取消挂接不删除会话',async()=>{
    const t=await newTask(),sid=await session()
    for(let i=0;i<2;i++)assert.deepEqual((await call('POST',`/tasks/${t.id}/sessions`,{sessionId:sid})).body.task.sessionIds,[sid])
    assert.equal((await call('POST',`/tasks/${t.id}/sessions`,{sessionId:'claude:missing'})).status,404)
    await call('DELETE',`/sessions/${sid}`);assert.deepEqual((await get(t.id)).sessionIds,[sid])
    await call('DELETE',`/tasks/${t.id}/sessions/${sid}`);assert.deepEqual((await get(t.id)).sessionIds,[])
    const sid2=await session();await call('POST',`/tasks/${t.id}/sessions`,{sessionId:sid2});await call('DELETE',`/tasks/${t.id}`)
    assert.equal((await call('GET',`/sessions/${sid2}/messages`)).status,200)
  })
  it('自动流转只影响 doing/review，多会话任一完成，手动 todo/done 不变',async()=>{
    const sid=await session(),sid2=await session(),ts=[]
    for(const status of ['todo','doing','review','done']){const t=await newTask();await call('PATCH',`/tasks/${t.id}`,{status});await call('POST',`/tasks/${t.id}/sessions`,{sessionId:sid});await call('POST',`/tasks/${t.id}/sessions`,{sessionId:sid2});ts.push(t);}
    await session('done',a.token,sid.split(':')[1])
    assert.deepEqual(await Promise.all(ts.map(async t=>(await get(t.id)).status)),['todo','review','review','done'])
    await session('running',a.token,sid.split(':')[1])
    assert.deepEqual(await Promise.all(ts.map(async t=>(await get(t.id)).status)),['todo','doing','doing','done'])
    assert.equal((await syncTaskForSession(pool,a.id,sid,'aborted')).length,0)
    assert.equal((await syncTaskForSession(pool,b.id,sid,'done')).length,0)
  })
  it('离线和参数错误不改任务；单机自动选择；消息优先级及 fresh 命令',async()=>{
    const t=await newTask();assert.equal((await call('POST',`/tasks/${t.id}/start`,{})).status,400)
    await call('PATCH',`/tasks/${t.id}`,{agent:'claude'});assert.equal((await call('POST',`/tasks/${t.id}/start`,{})).status,400)
    await call('PATCH',`/tasks/${t.id}`,{cwd:'D:\\TaskTest'});assert.equal((await call('POST',`/tasks/${t.id}/start`,{})).status,400)
    const off=await call('POST',`/tasks/${t.id}/start`,{machine:'离线'});assert.equal(off.status,200)
    assert.equal(off.body.queued,true);assert.ok(off.body.task.queuedAt);assert.equal((await get(t.id)).status,'todo')
    await call('DELETE',`/tasks/${t.id}/queue`);await call('PATCH',`/tasks/${t.id}`,{machine:null})
    const ex=await connect('role=agent&machine=任务测试机')
    for(const [body,expected] of [[{},'测试任务'],[{text:' 只回\0 OK '},'只回 OK']] as const){
      const r=await call('POST',`/tasks/${t.id}/start`,body);assert.equal(r.status,200)
      const m=await wait(()=>ex.msgs.find(m=>m.type==='run.start'&&m.runId===r.body.runId))
      assert.equal(m.mode,'fresh');assert.equal(m.sessionKey,'');assert.equal(m.text,expected);assert.equal(m.cwd,'D:\\TaskTest')
      assert.ok(r.body.task.sessionIds.includes(r.body.sessionId))
    }
    await call('PATCH',`/tasks/${t.id}`,{notes:'备注',status:'done'});assert.ok((await get(t.id)).doneAt)
    const r=await call('POST',`/tasks/${t.id}/start`,{});assert.equal(r.body.task.status,'doing');assert.equal(r.body.task.doneAt,null)
    assert.equal((await wait(()=>ex.msgs.find(m=>m.runId===r.body.runId))).text,'备注')
    assert.equal((await call('POST',`/tasks/${t.id}/start`,{text:'\0'})).status,400)
    assert.equal((await call('POST',`/tasks/${t.id}/start`,{agent:'bad'})).status,400)
    const ex2=await connect('role=agent&machine=另一台测试机')
    assert.equal((await call('POST',`/tasks/${t.id}/start`,{})).status,400)
    ex2.ws.close();ex.ws.close();await waitAsync(async()=>!(await call('GET','/control/status')).body.agents.length)
  })
  it('临时 ID 改名合并重复挂接；完成先于改名及 run.status 完成路径',async()=>{
    const ex=await connect('role=agent&machine=改名测试机'),t=await newTask({agent:'codex',cwd:'D:\\TaskTest',machine:'改名测试机'})
    const r=(await call('POST',`/tasks/${t.id}/start`,{})).body
    // real 的 agent 必须与 pending 相同，使用一个已完成的 Codex 会话。
    const key=randomUUID(),sid=`codex:${key}`
    await call('POST','/events',{events:[{agent:'codex',sessionId:key,machine:'改名测试机',cwd:'D:\\TaskTest',state:'done',at:new Date().toISOString()}]})
    await call('POST',`/tasks/${t.id}/sessions`,{sessionId:sid})
    ex.ws.send(JSON.stringify({type:'run.session',runId:r.runId,sessionKey:key}))
    await waitAsync(async()=>(await get(t.id)).sessionIds.includes(sid)&&!(await get(t.id)).sessionIds.includes(r.sessionId))
    assert.equal((await get(t.id)).sessionIds.filter((s:string)=>s===sid).length,1);assert.equal((await get(t.id)).status,'review')
    await call('PATCH',`/tasks/${t.id}`,{status:'doing'})
    ex.ws.send(JSON.stringify({type:'run.status',runId:r.runId,status:'done'}))
    await waitAsync(async()=>(await get(t.id)).status==='review')
    const r2=(await call('POST',`/tasks/${t.id}/start`,{})).body,key2=randomUUID()
    ex.ws.send(JSON.stringify({type:'run.status',runId:r2.runId,status:'done'}))
    ex.ws.send(JSON.stringify({type:'run.session',runId:r2.runId,sessionKey:key2}))
    await waitAsync(async()=>(await get(t.id)).status==='review'&&(await get(t.id)).sessionIds.includes(`codex:${key2}`))
    const r3=(await call('POST',`/tasks/${t.id}/start`,{})).body
    ex.ws.send(JSON.stringify({type:'run.status',runId:r3.runId,status:'failed',error:'测试失败'}))
    await waitAsync(async()=>(await call('GET',`/sessions/${r3.sessionId}/messages`)).body.run.status==='failed')
    assert.equal((await get(t.id)).status,'doing')
    ex.ws.close();await waitAsync(async()=>!(await call('GET','/control/status')).body.agents.length)
  })
  it('snapshot、创建/更新/删除广播及删除目标的任务更新只到同账号',async()=>{
    const va=await connect(),vb=await connect('',b.token)
    const snap=va.msgs.find(m=>m.type==='snapshot');assert.ok(snap.tasks.length);assert.ok(snap.goals.length)
    assert.deepEqual(vb.msgs.find(m=>m.type==='snapshot').tasks,[])
    const g=(await call('POST','/goals',{title:'广播目标'})).body.goal,t=await newTask({goalId:g.id})
    await call('PATCH',`/goals/${g.id}`,{priority:'high'})
    await call('DELETE',`/goals/${g.id}`);await call('DELETE',`/tasks/${t.id}`)
    await wait(()=>va.msgs.find(m=>m.type==='task.removed'&&m.id===t.id))
    assert.ok(va.msgs.find(m=>m.type==='goal'&&m.goal.id===g.id&&m.goal.priority==='medium'))
    assert.ok(va.msgs.find(m=>m.type==='goal'&&m.goal.id===g.id&&m.goal.priority==='high'))
    assert.ok(va.msgs.find(m=>m.type==='goal.removed'&&m.id===g.id))
    assert.ok(va.msgs.find(m=>m.type==='task'&&m.task.id===t.id&&m.task.goalId===null))
    assert.equal(vb.msgs.filter(m=>m.type!=='snapshot').length,0)
  })
  it('执行器发送失败：409、运行 failed、临时会话 aborted、任务退回待办并保留挂接',async()=>{
    const ex=await connect('role=agent&machine=发送失败测试机'),t=await newTask({agent:'claude',machine:'发送失败测试机',cwd:'D:\\TaskTest'})
    const originals=[...app.websocketServer.clients].map(ws=>({ws,send:ws.send}))
    for(const {ws,send} of originals) ws.send=function(this:typeof ws,data:any,...args:any[]){
      if(typeof data==='string'&&JSON.parse(data).type==='run.start')throw new Error('模拟发送失败')
      return (send as any).call(this,data,...args)
    } as typeof ws.send
    try {
      const r=await call('POST',`/tasks/${t.id}/start`,{});assert.equal(r.status,409)
      const updated=await get(t.id);assert.equal(updated.status,'todo');assert.equal(updated.sessionIds.length,1)
      const sid=updated.sessionIds[0], messages=(await call('GET',`/sessions/${sid}/messages`)).body
      assert.equal(messages.run.status,'failed')
      assert.equal((await call('GET','/sessions')).body.sessions.find((s:any)=>s.id===sid).state,'aborted')
    }finally{for(const {ws,send}of originals)ws.send=send;ex.ws.close();await waitAsync(async()=>!(await call('GET','/control/status')).body.agents.length);}
  })
  it('PATCH 的浏览器 CORS 预检允许',async()=>{
    const r=await app.inject({method:'OPTIONS',url:'/tasks/1',headers:{origin:'http://tauri.localhost','access-control-request-method':'PATCH','access-control-request-headers':'authorization,content-type'}})
    assert.equal(r.statusCode,204);assert.match(String(r.headers['access-control-allow-methods']),/PATCH/)
  })
  it('任务和目标时间持久化、时区归一化、部分更新与先后校验；checklist 可勾选删除',async()=>{
    for (const kind of ['tasks','goals']) {
      const created=await call('POST',`/${kind}`,{title:'有时间的事项',startAt:'2030-01-01T08:00:00+08:00',dueAt:'2030-01-02T08:00:00+08:00',remindStart:false})
      assert.equal(created.status,200)
      const entity=created.body[kind==='tasks'?'task':'goal']
      assert.equal(entity.startAt,'2030-01-01T00:00:00.000Z');assert.equal(entity.remindStart,false);assert.equal(entity.remindDue,true)
      for(const body of [{startAt:'2031-01-01T00:00:00Z'},{dueAt:'2020-01-01T00:00:00Z'},{startAt:'bad'},{startAt:'2030-01-01T08:00'},{remindDue:'true'}]) {
        assert.equal((await call('PATCH',`/${kind}/${entity.id}`,body)).status,400)
      }
      const updated=(await call('PATCH',`/${kind}/${entity.id}`,{startAt:null,remindDue:false})).body[kind==='tasks'?'task':'goal']
      assert.equal(updated.startAt,null);assert.equal(updated.dueAt,entity.dueAt);assert.equal(updated.remindDue,false)
    }
    const checklist=[{id:'one',text:' 第一步 ',done:false},{id:'two',text:'第二步',done:true}]
    const t=await newTask({checklist});assert.equal(t.checklist[0].text,'第一步')
    assert.equal((await get(t.id)).checklist[1].done,true)
    const updated=(await call('PATCH',`/tasks/${t.id}`,{checklist:[{...checklist[0],done:true}]})).body.task
    assert.equal(updated.checklist.length,1);assert.equal(updated.checklist[0].done,true);assert.equal(updated.status,'todo')
    for(const checklist of [null,[{id:'x',text:'',done:false}],[{id:'x',text:'x',done:'yes'}],[{id:'x',text:'x',done:false},{id:'x',text:'y',done:false}],Array(101).fill({id:'x',text:'x',done:false})]) {
      assert.equal((await call('PATCH',`/tasks/${t.id}`,{checklist})).status,400)
    }
    await call('PATCH',`/tasks/${t.id}`,{checklist:[]});assert.deepEqual((await get(t.id)).checklist,[])
  })
  it('到点广播、重连补提醒、去重、已处理同步及账号隔离',async()=>{
    const va=await connect(),vb=await connect('',b.token),at=new Date(Date.now()-1000).toISOString()
    const t=await newTask({startAt:at,dueAt:at})
    await wait(()=>va.msgs.find(m=>m.type==='reminder'&&m.reminder.entityId===t.id&&m.reminder.entityType==='task'&&m.reminder.kind==='due'))
    const entries=va.msgs.filter(m=>m.type==='reminder'&&m.reminder.entityType==='task'&&m.reminder.entityId===t.id)
    assert.equal(entries.length,2)
    assert.equal((await collectReminders(pool,a.id)).length,0)
    assert.equal(vb.msgs.filter(m=>m.type==='reminder').length,0)
    const reconnected=await connect(),pending=reconnected.msgs.find(m=>m.type==='snapshot').reminders.filter((r:any)=>r.entityType==='task'&&r.entityId===t.id)
    assert.equal(pending.length,2)
    assert.equal((await call('POST',`/reminders/${pending[0].id}/ack`,{},b.token)).status,404)
    assert.equal((await call('POST',`/reminders/${pending[0].id}/ack`,{})).status,200)
    await wait(()=>va.msgs.find(m=>m.type==='reminder.acked'&&m.id===pending[0].id))
    assert.equal((await listReminders(pool,a.id)).filter(r=>r.entityType==='task'&&r.entityId===t.id).length,1)
    await call('PATCH',`/tasks/${t.id}`,{status:'done'})
    assert.equal((await listReminders(pool,a.id)).filter(r=>r.entityType==='task'&&r.entityId===t.id).length,0)
    const g=(await call('POST','/goals',{title:'离线目标',dueAt:at})).body.goal
    const next=await connect()
    assert.ok(next.msgs.find(m=>m.type==='snapshot').reminders.some((r:any)=>r.entityType==='goal'&&r.entityId===g.id))
    await call('PATCH',`/goals/${g.id}`,{remindDue:false})
    assert.ok(!(await listReminders(pool,a.id)).some(r=>r.entityType==='goal'&&r.entityId===g.id))
    await call('PATCH',`/goals/${g.id}`,{remindDue:true,dueAt:'2030-01-01T00:00:00Z'})
    assert.ok(!(await listReminders(pool,a.id)).some(r=>r.entityType==='goal'&&r.entityId===g.id))
    await call('DELETE',`/goals/${g.id}`)
    assert.equal((await pool.query('SELECT * FROM entity_reminders WHERE goal_id=$1',[g.id])).rowCount,0)
  })
  it('已有 0.4 表的 schema 增量迁移不丢数据且重复执行幂等',async()=>{
    const schema=`tasks_migration_${randomUUID().replaceAll('-','')}`,db=await pool.connect()
    try {
      await db.query(`CREATE SCHEMA ${schema}`);await db.query(`SET search_path TO ${schema}`)
      await db.query('CREATE TABLE users(id bigserial PRIMARY KEY,email text UNIQUE NOT NULL,password_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT now())')
      await db.query("INSERT INTO users(email,password_hash) VALUES('keep@test','keep')")
      // 先以当前迁移建立旧状态表，再删除本次新增的空表，模拟 0.4 数据库。
      const url=new URL(DATABASE_URL);url.searchParams.set('options',`-c search_path=${schema}`)
      const old=createPool(url.toString())
      try {
        await migrate(old);await old.query('DROP TABLE entity_reminders,task_sessions,tasks,goals CASCADE')
        await old.query("INSERT INTO sessions(user_id,id,agent,machine,cwd,project,title,state,summary,state_since,acked,event_at,updated_at) VALUES(1,'claude:keep','claude','pc','','','','done','',now(),true,now(),now())")
        await migrate(old);await migrate(old)
        assert.equal((await old.query('SELECT * FROM sessions')).rows[0].id,'claude:keep')
        assert.equal((await old.query('SELECT * FROM users')).rows[0].email,'keep@test')
        assert.equal((await old.query('SELECT * FROM tasks')).rowCount,0)
        // 模拟已有目标但还没有优先级字段的版本，验证补默认值和重复迁移。
        await old.query('ALTER TABLE goals DROP COLUMN priority')
        await old.query("INSERT INTO goals(user_id,title,notes) VALUES(1,'保留目标','保留备注')")
        await migrate(old);await migrate(old)
        const kept=(await old.query('SELECT * FROM goals')).rows[0]
        assert.equal(kept.title,'保留目标');assert.equal(kept.notes,'保留备注');assert.equal(kept.priority,'medium')
        await old.query("UPDATE goals SET priority='high'");await migrate(old)
        assert.equal((await old.query('SELECT priority FROM goals')).rows[0].priority,'high')
      }finally{await old.end();}
    }finally{await db.query('RESET search_path');await db.query(`DROP SCHEMA ${schema} CASCADE`);db.release();}
  })
})
