import { native } from "./platform.ts";

type Snapshot = { key:string|null; error:string };
let snapshot: Snapshot = {key:null,error:""};
const listeners = new Set<()=>void>();
let generation=0, timer:number|undefined;
const publish=(value:Snapshot)=>{snapshot=value;listeners.forEach(f=>f());};
export const speechSnapshot=()=>snapshot;
export const subscribeSpeech=(fn:()=>void)=>{listeners.add(fn);return ()=>{listeners.delete(fn);};};

export function stopSpeech() {
  generation++;
  window.clearInterval(timer);timer=undefined;
  native()?.stopSpeech?.();
  window.speechSynthesis?.cancel();
  publish({key:null,error:""});
}
export function canSpeak() {
  return !!native()?.speak || ("speechSynthesis" in window && "SpeechSynthesisUtterance" in window);
}
export function startSpeech(key:string,text:string) {
  stopSpeech();
  const token=generation;
  if(!canSpeak()) {publish({key:null,error:"当前设备暂不支持朗读"});return;}
  publish({key,error:""});
  const bridge=native();
  if(bridge?.speak) {
    try { bridge.speak(text); }
    catch { publish({key:null,error:"无法启动设备朗读"});return; }
    timer=window.setInterval(()=>{
      if(token!==generation)return;
      const status=bridge.speechStatus?.() ?? "idle";
      if(status==="idle" || status.startsWith("error:")) {
        window.clearInterval(timer);timer=undefined;
        publish({key:null,error:status.startsWith("error:") ? status.slice(6) : ""});
      }
    },250);
    return;
  }
  // Short utterances avoid the long-text limits of system speech engines.
  const chars=Array.from(text), chunks:string[]=[];
  for(let i=0;i<chars.length;i+=1000)chunks.push(chars.slice(i,i+1000).join(""));
  let index=0;
  const next=()=>{
    if(token!==generation)return;
    if(index>=chunks.length){publish({key:null,error:""});return;}
    const utterance=new SpeechSynthesisUtterance(chunks[index++]);
    utterance.lang=/[\u3400-\u9fff]/.test(text) ? "zh-CN" : "en-US";
    utterance.onend=next;
    utterance.onerror=()=>{if(token===generation)publish({key:null,error:"朗读失败，请检查设备语音设置后重试"});};
    window.speechSynthesis.speak(utterance);
  };
  next();
}
