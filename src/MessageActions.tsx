import { useEffect, useState, useSyncExternalStore } from "react";
import type { Api, Message } from "./lib/api";
import { native } from "./lib/platform";
import { canSpeak, speechSnapshot, startSpeech, stopSpeech, subscribeSpeech } from "./lib/speech";
import Icon from "./Icon";

export default function MessageActions({message,api,branchReason,onBranch,onRated}:{message:Message;api:Api;branchReason:string;onBranch():void;onRated(m:Message):void}) {
  const [notice,setNotice]=useState(""),[saving,setSaving]=useState(false);
  const speech=useSyncExternalStore(subscribeSpeech,speechSnapshot);
  const key=`${message.sessionId}:${message.sourceId ?? message.id}`;
  const speaking=speech.key===key;
  useEffect(()=>{if(!notice)return;const t=window.setTimeout(()=>setNotice(""),3500);return ()=>window.clearTimeout(t);},[notice]);
  const copy=async()=>{
    try {
      const bridge=native();
      if(bridge?.copyText)bridge.copyText(message.text);
      else await navigator.clipboard.writeText(message.text);
      setNotice("已复制");
    } catch {setNotice("复制失败，请选择回复文字后手动复制");}
  };
  const rate=async(value:"up"|"down")=>{
    setSaving(true);
    try {onRated(await api.rateMessage(message.sessionId,message.id,message.rating===value ? null : value));setNotice("评价已保存到 AgentHub");}
    catch(e){setNotice(e instanceof Error?e.message:String(e));}
    finally{setSaving(false);}
  };
  const feedbackReason=!message.sourceId ? "请刷新记录以获取回复标识" : "";
  return <div className="reply-tools">
    <div className="reply-buttons" role="group" aria-label="回复操作">
      <button type="button" title="复制回复" aria-label="复制回复" onClick={()=>void copy()}><Icon name="copy"/></button>
      <button type="button" title={feedbackReason||"评价：有帮助"} aria-label="评价：有帮助" aria-pressed={message.rating==="up"} disabled={saving||!!feedbackReason} onClick={()=>void rate("up")}><Icon name="up"/></button>
      <button type="button" title={feedbackReason||"评价：没帮助"} aria-label="评价：没帮助" aria-pressed={message.rating==="down"} disabled={saving||!!feedbackReason} onClick={()=>void rate("down")}><Icon name="down"/></button>
      <button type="button" title={canSpeak() ? speaking?"停止朗读":"朗读回复" : "当前设备不支持朗读"} aria-label={speaking?"停止朗读":"朗读回复"} aria-pressed={speaking} disabled={!canSpeak()} onClick={()=>speaking?stopSpeech():startSpeech(key,message.text)}><Icon name={speaking?"stop":"speak"}/></button>
      <button type="button" title={branchReason||"从此处分支到新聊天"} aria-label="从此处分支到新聊天" disabled={!!branchReason} onClick={onBranch}><Icon name="branch"/><span>分支</span></button>
    </div>
    <span className="reply-notice" role="status">{notice}</span>
  </div>;
}
