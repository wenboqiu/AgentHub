// Offline integration probe. Only generated temporary sessions and a local fake model endpoint.
import {mkdtemp, mkdir, writeFile, readFile, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createServer} from 'node:http';
import assert from 'node:assert/strict';

const dir=await mkdtemp(join(tmpdir(),'agenthub-reply-branch-'));
const cwd=join(dir,'project');await mkdir(cwd);
console.log('Fixture:',dir);
const hash=x=>createHash('sha256').update(x).digest('hex');
const files=async root=>{const out=[];for(const e of await readdir(root,{withFileTypes:true}).catch(()=>[])){const p=join(root,e.name);if(e.isDirectory())out.push(...await files(p));else out.push(p)}return out};
const wait=async(fn)=>{for(let i=0;i<100;i++){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,50))}throw Error('fixture file timeout')};
const codexBin=process.argv[2];

async function codexProbe(){
  if(!codexBin)throw Error('Pass the local Codex executable as first argument');
  const home=join(dir,'codex-home');await mkdir(home);
  const processes=[];
  const connect=()=>{
    const child=spawn(codexBin,['app-server'],{cwd,env:{...process.env,CODEX_HOME:home},windowsHide:true,stdio:['pipe','pipe','pipe']});processes.push(child);
    let seq=0;const pending=new Map();
    createInterface({input:child.stdout}).on('line',line=>{let v;try{v=JSON.parse(line)}catch{return}const p=pending.get(v.id);if(p){pending.delete(v.id);v.error?p.reject(Error(JSON.stringify(v.error))):p.resolve(v.result)}});
    child.stderr.resume();
    child.on('exit',()=>{for(const p of pending.values())p.reject(Error('app-server exited'));pending.clear()});
    const send=(method,params)=>new Promise((resolve,reject)=>{const id=++seq;const timeout=setTimeout(()=>{pending.delete(id);reject(Error(`timeout: ${method}`))},20000);pending.set(id,{resolve:v=>{clearTimeout(timeout);resolve(v)},reject:e=>{clearTimeout(timeout);reject(e)}});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n')});
    return {child,send,init:async()=>{await send('initialize',{clientInfo:{name:'agenthub-offline-probe',version:'1.0'}});child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'initialized'})+'\n')}};
  };
  try{
    let c;
    const original=randomUUID();
    const now=new Date(), day=now.toISOString().slice(0,10);
    const folder=join(home,'sessions',...day.split('-'));await mkdir(folder,{recursive:true});
    const source=join(folder,`rollout-${day}T00-00-00-${original}.jsonl`);
    await writeFile(source,JSON.stringify({timestamp:now.toISOString(),type:'session_meta',payload:{id:original,timestamp:now.toISOString(),cwd,originator:'codex_cli_rs',cli_version:'0.0.0',source:'cli',model_provider:'openai'}})+'\n');
    const turn1=randomUUID(),turn2=randomUUID();
    const records=[];
    for(const [id,marker] of [[turn1,'EARLY_ONLY'],[turn2,'LATER_ONLY']]){
      const timestamp=new Date().toISOString();
      records.push({timestamp,type:'event_msg',payload:{type:'task_started',turn_id:id,model_context_window:200000}});
      records.push({timestamp,type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'Question '+marker}]}});
      records.push({timestamp,type:'response_item',payload:{type:'message',id:randomUUID(),role:'assistant',phase:'final_answer',content:[{type:'output_text',text:marker}]}});
      records.push({timestamp,type:'event_msg',payload:{type:'task_complete',turn_id:id,last_agent_message:marker}});
    }
    const before=await readFile(source);const originalText=before.toString()+records.map(v=>JSON.stringify(v)+'\n').join('');await writeFile(source,originalText);
    const originalHash=hash(await readFile(source));
    c=connect();await c.init();
    const fork=(await c.send('thread/fork',{threadId:original,lastTurnId:turn1})).thread.id;
    assert.notEqual(fork,original);
    const path=await wait(async()=>(await files(home)).find(p=>p.endsWith(`${fork}.jsonl`)));
    const forkText=await readFile(path,'utf8');assert.ok(forkText.includes('EARLY_ONLY'));assert.ok(!forkText.includes('LATER_ONLY'));
    assert.equal(hash(await readFile(source)),originalHash);
    console.log('Codex PASS: native lastTurnId excludes later turn, parent unchanged, new thread id.');
  }finally{for(const p of processes){p.stdin.end();p.kill()}}
}

async function claudeProbe(){
  const config=join(dir,'claude-home');await mkdir(config);
  const id=randomUUID(),point=randomUUID(),later=randomUUID();
  const project=join(config,'projects',cwd.replace(/[^a-zA-Z0-9]/g,'-'));await mkdir(project,{recursive:true});
  const source=join(project,`${id}.jsonl`),records=[];
  let parent=null;
  for(const [uuid,marker] of [[point,'EARLY_ONLY'],[later,'LATER_ONLY']]){
    const user=randomUUID();
    records.push({type:'user',uuid:user,parentUuid:parent,sessionId:id,cwd,timestamp:new Date().toISOString(),version:'2.1.0',isSidechain:false,message:{role:'user',content:'Question '+marker}});
    records.push({type:'assistant',uuid,parentUuid:user,sessionId:id,cwd,timestamp:new Date().toISOString(),version:'2.1.0',isSidechain:false,message:{id:'msg_'+uuid,type:'message',role:'assistant',model:'claude-sonnet-4-6',content:[{type:'text',text:marker}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:1,output_tokens:1}}});parent=uuid;
  }
  await writeFile(source,records.map(v=>JSON.stringify(v)).join('\n')+'\n');const originalHash=hash(await readFile(source));
  const requests=[];
  const server=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    if(req.url?.includes('count_tokens')){res.setHeader('Content-Type','application/json');res.end('{"input_tokens":10}');return}
    if(!req.url?.includes('/messages')){res.setHeader('Content-Type','application/json');res.end('{}');return}
    const v=JSON.parse(body);requests.push(v);
    const answer={id:'msg_probe',type:'message',role:'assistant',model:v.model,content:[{type:'text',text:'OK'}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:10,output_tokens:1}};
    if(!v.stream){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(answer));return}
    res.setHeader('Content-Type','text/event-stream');
    for(const data of [{type:'message_start',message:{...answer,content:[],stop_reason:null}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'OK'}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:1}},{type:'message_stop'}])res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
    res.end();
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const env={...process.env,CLAUDE_CONFIG_DIR:config,ANTHROPIC_API_KEY:'sk-ant-test-offline-probe',ANTHROPIC_BASE_URL:`http://127.0.0.1:${server.address().port}`,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1'};
  delete env.ANTHROPIC_AUTH_TOKEN;delete env.CLAUDE_CODE_OAUTH_TOKEN;
  const child=spawn('claude',['-p','--resume',id,'--fork-session','--resume-session-at',point,'--input-format','stream-json','--output-format','stream-json','--verbose','--permission-prompt-tool','stdio','--permission-mode','default'],{cwd,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
  let stderr='';child.stderr.on('data',b=>stderr+=b);let result;
  const complete=new Promise((resolve,reject)=>{
    child.on('error',reject);child.on('exit',code=>result?resolve(result):reject(Error(`Claude exit ${code}: ${stderr.slice(-1500)}`)));
    createInterface({input:child.stdout}).on('line',line=>{let v;try{v=JSON.parse(line)}catch{return}if(v.type==='result'){result=v;child.stdin.end();resolve(v)}});
  });
  child.stdin.write(JSON.stringify({type:'user',message:{role:'user',content:'BRANCH_PROBE'}})+'\n');
  const timeout=setTimeout(()=>child.kill(),45000);
  try{
    const r=await complete;assert.equal(r.subtype,'success');assert.notEqual(r.session_id,id);
    assert.ok(requests.length>0);const context=JSON.stringify(requests[0].messages);assert.ok(context.includes('EARLY_ONLY'));assert.ok(!context.includes('LATER_ONLY'));
    assert.equal(hash(await readFile(source)),originalHash);
    console.log('Claude PASS: --resume-session-at excludes later reply, parent unchanged, new session id.');
  }finally{clearTimeout(timeout);child.stdin.end();child.kill();await new Promise(r=>server.close(r))}
}

await codexProbe();await claudeProbe();
