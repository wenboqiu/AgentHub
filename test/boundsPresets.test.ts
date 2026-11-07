import {test} from "node:test";
import assert from "node:assert/strict";
import {BOUND_PRESETS,applyPreset,presetHint,presetOf} from "../src/lib/boundsPresets.ts";
import type {TaskConstraints} from "../src/lib/api.ts";

const none:TaskConstraints={paths:["server/src"],net:false,push:false,scripts:false,note:""};

test("没写说明的空边界落在「常规改代码」，不是一上来就说只读",()=>{
  assert.equal(presetOf(none),"code");
});

test("说明还是模板那句时，反推回对应那一档",()=>{
  const read=BOUND_PRESETS.find(p=>p.id==="read")!;
  assert.equal(presetOf({...none,note:read.note}),"read");
});

test("说明被人改过就算自定义，不假装还是模板",()=>{
  assert.equal(presetOf({...none,note:"只动服务端，前端这次不碰"}),"custom");
  assert.match(presetHint({...none,note:"只动服务端"}),/自己写的/);
});

test("开关组合拼不出任何一档时也是自定义（net+push 不等于发版）",()=>{
  assert.equal(presetOf({...none,net:true,push:true}),"custom");
});

test("套发版只改三个开关和说明，不动「只允许改」",()=>{
  const next=applyPreset(none,"release");
  assert.deepEqual({net:next.net,push:next.push,scripts:next.scripts},{net:false,push:true,scripts:true});
  assert.deepEqual(next.paths,["server/src"]);
  assert.match(next.note,/推远端/);
});

test("人自己写的说明不套模板就保留，别替人删字",()=>{
  const mine={...none,note:"只动服务端，前端这次不碰"};
  const next=applyPreset(mine,"deps");
  assert.equal(next.net,true);
  assert.equal(next.note,"只动服务端，前端这次不碰");
  // 说明不是模板的，就等于还停在自定义档
  assert.equal(presetOf(next),"custom");
});

test("自定义档什么都不改",()=>{
  assert.deepEqual(applyPreset(none,"custom"),none);
});
