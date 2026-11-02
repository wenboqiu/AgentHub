import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
// Real Claude CLI + local fake Messages API. Disables hooks and tools; never targets a user's existing session.
// PowerShell: $env:AGENTHUB_TEST_CLAUDE=(Get-Command claude).Source; node server/tools/verify-claude-terminal.mjs
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import net from 'node:net';
const cwd=await mkdtemp(join(tmpdir(),'agenthub-terminal-check-'));
const marker='AGENTHUB_TERMINAL_TEST_'+randomUUID();
let count=0, child, output='', received=false;
const server=createServer(async(req,res)=>{
 let body='';for await(const c of req)body+=c;
 if(req.url.includes('count_tokens')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({input_tokens:100}));return;}
 if(!req.url.includes('/messages')){res.setHeader('Content-Type','application/json');res.end('{}');return;}
 count++;
 if(body.includes(marker))received=true;
 const text=body.includes(marker)?'TERMINAL_REPLY_OK':'SEED_OK';
 const m={id:'msg_'+randomUUID(),type:'message',role:'assistant',model:'claude-haiku-4-5',content:[{type:'text',text}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:10,output_tokens:5}};
 const parsed=JSON.parse(body);
 if(!parsed.stream){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(m));return;}
 res.setHeader('Content-Type','text/event-stream');
 const events=[['message_start',{type:'message_start',message:{...m,content:[],stop_reason:null}}],['content_block_start',{type:'content_block_start',index:0,content_block:{type:'text',text:''}}],['content_block_delta',{type:'content_block_delta',index:0,delta:{type:'text_delta',text}}],['content_block_stop',{type:'content_block_stop',index:0}],['message_delta',{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:5}}],['message_stop',{type:'message_stop'}]];
 for(const [event,data]of events)res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
 res.end();
});
const pause=()=>new Promise(r=>setTimeout(r,100));
async function until(fn,ms=30000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await pause();}throw Error('验证超时');}
await new Promise(r=>server.listen(0,'127.0.0.1',r));
try{
 const cli=process.env.AGENTHUB_TEST_CLAUDE;
 if(!cli)throw Error('缺少测试 CLI 路径');
 child=spawn(cli,['-p','--input-format','stream-json','--output-format','stream-json','--verbose','--permission-mode','default','--tools','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--setting-sources','','--settings','{"disableAllHooks":true}'],{cwd,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,ANTHROPIC_API_KEY:'agenthub-local-test-only',ANTHROPIC_AUTH_TOKEN:'agenthub-local-test-only',ANTHROPIC_BASE_URL:`http://127.0.0.1:${server.address().port}`}});
 child.stdout.on('data',c=>{output+=c.toString();if(output.length>1024*1024)output=output.slice(-1024*1024);});child.stderr.on('data',()=>{});
 child.stdin.write(JSON.stringify({type:'user',message:{role:'user',content:'Only reply SEED_OK.'}})+'\n');
 await until(()=>output.includes('"type":"result"')&&output.includes('SEED_OK'));
 const sessions=join(homedir(),'.claude','sessions');
 const registry=JSON.parse(await readFile(join(sessions,`${child.pid}.json`),'utf8'));
 if(registry.cwd!==cwd||!registry.messagingSocketPath)throw Error('测试会话未发布本机收件地址');
 const socket=registry.messagingSocketPath;
 const hash=createHash('sha256').update(socket.toLowerCase()).digest('hex');
 const auth=JSON.parse(await readFile(join(sessions,`${child.pid}.${hash}.key`),'utf8'));
 const id=randomUUID();
 await new Promise((resolve,reject)=>{const c=net.connect(socket);c.setTimeout(3000);c.on('timeout',()=>{c.destroy();reject(Error('管道超时'));});c.on('error',reject);c.on('connect',()=>c.end(JSON.stringify({type:'auth',token:auth.peerToken})+'\n'+JSON.stringify({type:'user',session_id:registry.sessionId,uuid:id,msg_id:id,from:'AgentHub',priority:'next',message:{role:'user',content:marker}})+'\n'));c.on('close',resolve);});
 await until(()=>received&&output.includes('TERMINAL_REPLY_OK'));
 const project=cwd.replace(/[^a-zA-Z0-9]/g,'-');
 const transcript=join(homedir(),'.claude','projects',project,`${registry.sessionId}.jsonl`);
 const rows=(await readFile(transcript,'utf8')).trim().split('\n').map(s=>JSON.parse(s));
 const injected=rows.find(r=>r.type==='user'&&r.uuid===id);
 const reply=rows.find(r=>r.type==='assistant'&&r.message?.content?.some(c=>c.text==='TERMINAL_REPLY_OK'));
 if(!injected||!reply)throw Error('原生对话记录中缺少投递消息或回复');
 const result={ok:true,calls:count,sameSession:true,recordedMessage:true,stopReason:reply.message.stop_reason,fixture:cwd};
 await writeFile(join(cwd,'result.json'),JSON.stringify(result,null,2));
 console.log(JSON.stringify(result));
}finally{
 if(child&&!child.killed){child.stdin.end();const exited=await Promise.race([new Promise(r=>child.once('exit',()=>r(true))),new Promise(r=>setTimeout(()=>r(false),2000))]);if(!exited)child.kill();}
 server.closeAllConnections();server.close();
}
