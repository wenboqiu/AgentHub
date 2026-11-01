// 只清理由 task-acceptance.ts 在系统临时目录创建的会话；不接受任意会话 ID。
import { readFile, readdir, stat, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'

const fixture=resolve(process.argv[2] ?? '')
if(dirname(fixture)!==resolve(tmpdir()) || !/^agenthub-task-acceptance-[A-Za-z0-9]+$/.test(basename(fixture))) throw new Error('不是本工具创建的临时目录')
const result=JSON.parse(await readFile(join(fixture,'result.json'),'utf8'))
const cwd=resolve(fixture,'project')
if(resolve(result.task.cwd)!==cwd) throw new Error('测试项目目录不匹配')
const sessions:string[]=result.task.sessionIds
if(!sessions.every(s=>/^(claude|codex):[0-9a-f-]{36}$/.test(s))) throw new Error('测试会话 ID 不合法')
const codex=sessions.filter(s=>s.startsWith('codex:')).map(s=>s.slice(6))
if(codex.length) {
  const bin=join(process.env.LOCALAPPDATA!,'OpenAI','Codex','bin')
  const candidates=await Promise.all((await readdir(bin)).map(async d=>{const path=join(bin,d,'codex.exe');try{return {path,time:(await stat(path)).mtimeMs};}catch{return null;}}))
  const exe=candidates.filter(v=>v!==null).sort((a,b)=>b.time-a.time)[0]?.path
  if(!exe)throw new Error('找不到 Codex app-server')
  const child=spawn(exe,['app-server'],{cwd,windowsHide:true,stdio:['pipe','pipe','ignore']})
  const pending=new Map<number,{ok:(v:unknown)=>void;fail:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>()
  const lines=createInterface({input:child.stdout})
  lines.on('line',line=>{try{const m=JSON.parse(line),p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);if(m.error)p.fail(new Error(JSON.stringify(m.error)));else p.ok(m.result);}}catch{}})
  let next=1
  const request=(method:string,params:unknown)=>new Promise((ok,fail)=>{const id=next++;pending.set(id,{ok,fail,timer:setTimeout(()=>{pending.delete(id);fail(new Error('归档超时'));},20_000)});child.stdin.write(JSON.stringify({id,method,params})+'\n');})
  try {
    await request('initialize',{clientInfo:{name:'agenthub-acceptance-cleanup',version:'0.5.0'}})
    child.stdin.write(JSON.stringify({method:'initialized'})+'\n')
    for(const id of codex){await request('thread/archive',{threadId:id});console.log(`已归档 Codex 测试线程 ${id}`);}
  }finally{for(const p of pending.values())clearTimeout(p.timer);lines.close();child.stdin.end();child.kill();}
}
const projectRoot=resolve(process.env.USERPROFILE!,'.claude','projects')
const encoded=cwd.replace(/[^a-zA-Z0-9]/g,'-')
const transcriptDir=resolve(projectRoot,encoded)
// 编码目录必须对应本次唯一的临时项目，且必须直接位于 Claude projects 目录内。
if(dirname(transcriptDir)!==projectRoot || !encoded.includes(basename(fixture)))throw new Error('拒绝清理非测试目录')
await rm(transcriptDir,{recursive:true,force:true})
console.log('已清理本次临时项目的 Claude 会话目录')
