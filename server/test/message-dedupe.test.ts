import {after,before,describe,it} from 'node:test'
import assert from 'node:assert/strict'
import {buildApp} from '../src/index.ts'
import {appendEventMessages,createPool,createRun,insertMessage,listMessages} from '../src/db.ts'
import {DATABASE_URL,makeUser} from './helpers.ts'

/**
 * 只读监听通道（WorkBuddy / CodeBuddy）的正文去重。
 * 症状：用户从 AgentHub 发进 CodeBuddy 会话的那句话，transcript 回显后界面上变成两条。
 */
describe('事件正文去重',()=>{
  const pool=createPool(DATABASE_URL)
  let user:Awaited<ReturnType<typeof makeUser>>
  let app:Awaited<ReturnType<typeof buildApp>>
  // 建 app 顺便跑迁移：本地库常年是旧 schema，不跑 runs.model 这类新列不存在
  before(async()=>{app=await buildApp(DATABASE_URL,'silent',{});user=await makeUser(pool)})
  after(async()=>{await app?.close();if(user)await pool.query('DELETE FROM users WHERE id=$1',[user.id]);await pool.end()})

  it('发出去的那句话：回显折成一行、晚几秒也认得出，不会插第二条',async()=>{
    const key=`codebuddy:dedupe-echo-${Date.now()}`
    const run=await createRun(pool,user.id,`run-echo-${Date.now()}`,key,'dedupe-pc')
    await pool.query("UPDATE runs SET status='running' WHERE id=$1",[run.id])
    const typed='调研一下 super agent\n跟现在的实现差在哪'
    await insertMessage(pool,user.id,key,run.id,'user',typed)
    // 用户点发送是 6 秒前；transcript 回显是 CLI 真正开跑时才落盘的，时间差就出在这里
    await pool.query("UPDATE messages SET created_at=now()-interval '6 seconds' WHERE user_id=$1 AND session_id=$2",[user.id,key])
    const at=new Date()
    const added=await appendEventMessages(pool,user.id,key,[{role:'user',text:'调研一下 super agent 跟现在的实现差在哪',at:at.toISOString()}],at)
    assert.equal(added,0)
    const list=await listMessages(pool,user.id,key,50)
    assert.equal(list.length,1)
    assert.equal(list[0].text,typed)
  })

  it('run 结束后同一句话再说一遍：那是新的一条，照样入库',async()=>{
    const key=`codebuddy:dedupe-again-${Date.now()}`
    const run=await createRun(pool,user.id,`run-again-${Date.now()}`,key,'dedupe-pc')
    await insertMessage(pool,user.id,key,run.id,'user','继续')
    await pool.query("UPDATE messages SET created_at=now()-interval '6 seconds' WHERE user_id=$1 AND session_id=$2",[user.id,key])
    // 这一轮已经跑完：没有「自己发出去的那句」要认，晚 6 秒的就是新输入
    await pool.query("UPDATE runs SET status='done' WHERE id=$1",[run.id])
    const at=new Date()
    const added=await appendEventMessages(pool,user.id,key,[{role:'user',text:'继续',at:at.toISOString()}],at)
    assert.equal(added,1)
    assert.equal((await listMessages(pool,user.id,key,50)).length,2)
  })

  it('重发一条很旧的消息：不在「最近 200 条」窗口里也不会重复入库',async()=>{
    const key=`workbuddy:dedupe-old-${Date.now()}`
    const at=new Date(Date.now()-3_600_000)
    await pool.query("INSERT INTO messages (user_id,session_id,role,text,created_at) VALUES ($1,$2,'assistant',$3,$4)",[user.id,key,'很旧的一段回复',at])
    // 之后又堆了两百多条：按「最近 200 条」取就看不到上面那条了
    await pool.query(`INSERT INTO messages (user_id,session_id,role,text,created_at)
      SELECT $1,$2,'assistant','填充 '||g, $3::timestamptz + (g||' seconds')::interval FROM generate_series(1,230) g`,[user.id,key,at])
    const added=await appendEventMessages(pool,user.id,key,[{role:'assistant',text:'很旧的一段回复',at:at.toISOString()}],at)
    assert.equal(added,0)
    const rows=await pool.query("SELECT count(*)::int AS n FROM messages WHERE user_id=$1 AND session_id=$2 AND text='很旧的一段回复'",[user.id,key])
    assert.equal(rows.rows[0].n,1)
  })
})
