// 本机桌面验收夹具：只使用本地服务端和临时账号。创建 stop 文件结束并恢复原配置。
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile, mkdir, access, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { buildApp } from '../src/index.ts'
import { createPool, listMessages } from '../src/db.ts'
import { hashPassword, newAuthSession } from '../src/auth.ts'
import { getTask, saveGoal, saveTask } from '../src/tasks.ts'

const repo=resolve(import.meta.dirname,'../..')
const configPath=join(process.env.APPDATA!,'com.wenbo.agenthub','config.json')
const installed=join(process.env.LOCALAPPDATA!,'AgentHub','agenthub.exe')
const exe=join(repo,'src-tauri','target','release','agenthub.exe')
const fixture=await mkdtemp(join(tmpdir(),'agenthub-task-acceptance-'))
const cwd=join(fixture,'project');await mkdir(cwd)
const backup=await readFile(configPath)
await writeFile(join(fixture,'config.backup'),backup)
const ps=(command:string)=>execFileSync('powershell.exe',['-NoProfile','-Command',command],{encoding:'utf8',windowsHide:true}).trim()
const installedRunning=ps("Get-Process agenthub -ErrorAction SilentlyContinue | Where-Object Path -EQ (Join-Path $env:LOCALAPPDATA 'AgentHub\\agenthub.exe') | Select-Object -ExpandProperty Id")
const pool=createPool('postgres://postgres:dev@127.0.0.1:55433/agenthub')
let app:Awaited<ReturnType<typeof buildApp>>|undefined, child:ReturnType<typeof spawn>|undefined, userId:number|undefined, configChanged=false
try {
  app=await buildApp('postgres://postgres:dev@127.0.0.1:55433/agenthub','silent')
  await app.listen({port:3000,host:'127.0.0.1'})
  const email=`desktop-${randomUUID()}@test.dev`
  userId=Number((await pool.query('INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id',[email,await hashPassword(randomUUID())])).rows[0].id)
  const token=await newAuthSession(pool,userId,'桌面验收')
  const goal=await saveGoal(pool,userId,{title:'测试目标'})
  const task=await saveTask(pool,userId,{title:'测试任务',notes:'只回复 OK，不要调用任何工具。',goalId:goal.id,agent:'claude',machine:'E2E-PC',cwd})
  if(installedRunning)ps("Get-Process agenthub -ErrorAction SilentlyContinue | Where-Object Path -EQ (Join-Path $env:LOCALAPPDATA 'AgentHub\\agenthub.exe') | Stop-Process -Force")
  configChanged=true
  await writeFile(configPath,JSON.stringify({serverUrl:'http://127.0.0.1:3000',token,email,machine:'E2E-PC',notifyDesktop:false,remoteEnabled:true,allowedRoots:[cwd]}))
  child=spawn(exe,[],{windowsHide:true,stdio:'ignore',env:{...process.env,ANTHROPIC_MODEL:'haiku',WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:''}})
  child.on('error',e=>console.error('桌面启动失败',e.message))
  await writeFile(join(fixture,'fixture.json'),JSON.stringify({userId,token,taskId:task.id,goalId:goal.id,cwd}))
  console.log(JSON.stringify({fixture,taskId:task.id,goalId:goal.id,desktopPid:child.pid,stopFile:join(fixture,'stop')}))
  let last=''
  const end=Date.now()+25*60_000
  while(Date.now()<end){
    try{await access(join(fixture,'stop'));break;}catch{}
    const current=await getTask(pool,userId,task.id)
    const state=JSON.stringify({status:current.status,sessionIds:current.sessionIds})
    if(state!==last){console.log(state);last=state;}
    await new Promise(r=>setTimeout(r,1000))
  }
  const current=await getTask(pool,userId,task.id)
  const messages=(await Promise.all(current.sessionIds.map(s=>listMessages(pool,userId!,s,200)))).flat()
  const result={task:current,assistant:messages.filter(m=>m.role==='assistant').map(m=>m.text),user:messages.filter(m=>m.role==='user').map(m=>m.text)}
  await writeFile(join(fixture,'result.json'),JSON.stringify(result,null,2))
  console.log(JSON.stringify({finalStatus:current.status,realSession:current.sessionIds.some(s=>!s.includes(':pending-')),assistant:result.assistant}))
} finally {
  if(child?.pid){try{execFileSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}catch{}}
  if(configChanged){await writeFile(configPath,backup);if(!(await readFile(configPath)).equals(backup))throw new Error('配置恢复校验失败');console.log('原配置已按字节恢复');await unlink(join(fixture,'config.backup'));}
  if(installedRunning&&configChanged)ps("Start-Process -FilePath (Join-Path $env:LOCALAPPDATA 'AgentHub\\agenthub.exe') -ArgumentList '--silent' -WindowStyle Hidden")
  if(userId)await pool.query('DELETE FROM users WHERE id=$1',[userId])
  await app?.close();await pool.end()
  console.log('测试账号已清理，本地服务已停止')
}
