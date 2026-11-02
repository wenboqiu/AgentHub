import {test} from 'node:test';
import assert from 'node:assert/strict';

class Utterance {
  text:string;lang='';onend:(()=>void)|null=null;onerror:(()=>void)|null=null;
  constructor(text:string){this.text=text;}
}
const spoken:Utterance[]=[];
const fakeWindow:any={speechSynthesis:{cancel(){},speak:(u:Utterance)=>spoken.push(u)},SpeechSynthesisUtterance:Utterance,setInterval,clearInterval};
Object.defineProperty(globalThis,'window',{value:fakeWindow,configurable:true});
Object.defineProperty(globalThis,'SpeechSynthesisUtterance',{value:Utterance,configurable:true});
const speech=await import('../src/lib/speech.ts');

test('朗读分段保留完整 Unicode，换回复后旧回调不能继续播报',()=>{
  const text='中文回复😀'.repeat(300);
  speech.startSpeech('first',text);
  const first=spoken.at(-1)!;
  assert.equal(first.lang,'zh-CN');
  const chunks=[first.text];
  while(speech.speechSnapshot().key==='first'){
    const u=spoken.at(-1)!;u.onend?.();
    if(speech.speechSnapshot().key==='first')chunks.push(spoken.at(-1)!.text);
  }
  assert.equal(chunks.join(''),text);
  speech.startSpeech('old','old reply');const old=spoken.at(-1)!;
  speech.startSpeech('new','new reply');const count=spoken.length;
  old.onend?.();assert.equal(spoken.length,count);assert.equal(speech.speechSnapshot().key,'new');
  speech.stopSpeech();assert.equal(speech.speechSnapshot().key,null);
});

test('朗读失败恢复按钮状态，缺少语音能力时明确报错',()=>{
  speech.startSpeech('bad','reply');spoken.at(-1)!.onerror?.();
  assert.equal(speech.speechSnapshot().key,null);assert.ok(speech.speechSnapshot().error);
  delete fakeWindow.speechSynthesis;delete fakeWindow.SpeechSynthesisUtterance;
  assert.equal(speech.canSpeak(),false);speech.startSpeech('none','reply');
  assert.equal(speech.speechSnapshot().key,null);assert.ok(speech.speechSnapshot().error);
});
