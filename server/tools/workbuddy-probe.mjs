#!/usr/bin/env node
// WorkBuddy 会话探针（原型验证）：只读轮询 ~/.workbuddy/projects/<工作区>/<sessionId>.jsonl，
// 增量解析新行并输出 AgentHub 风格的事件，用于评估 AgentHub 接入 WorkBuddy 的可行性。
//
// 用法：node tools/workbuddy-probe.mjs [--interval 2] [--duration 30] [--quiet 10]
//   --interval  轮询间隔秒数（默认 2）
//   --duration  总运行秒数，0 表示一直运行（默认 30）
//   --quiet     末条消息完成后静默多少秒判定为 idle（默认 10，启发式，仅推测）
//
// 零依赖，仅用 Node 内置模块；只读，不写任何 WorkBuddy 文件。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : dflt;
};
const INTERVAL_MS = opt('interval', 2) * 1000;
const DURATION_MS = opt('duration', 30) * 1000;
const QUIET_MS = opt('quiet', 10) * 1000;
const RECENT_DAYS = opt('recent', 7);

const PROJECTS_DIR = path.join(os.homedir(), '.workbuddy', 'projects');
const AGENT = 'workbuddy';

// ---------- 状态 ----------
/** @type {Map<string, {offset:number, session:object}>} file -> 状态 */
const tracked = new Map();

function previewOf(line) {
  const texts = (line.content ?? [])
    .map(c => (typeof c === 'object' && c && typeof c.text === 'string' ? c.text : ''))
    .filter(Boolean);
  const raw = texts.join(' ');
  // 跳过系统注入段，只取可见文本
  const cut = raw.indexOf('<system-reminder');
  const visible = cut > 0 ? raw.slice(0, cut) : raw;
  return visible.replace(/\s+/g, ' ').trim().slice(0, 60);
}

function textOf(line) {
  return (line.content ?? [])
    .filter(c => c && (c.type === 'input_text' || c.type === 'output_text'))
    .map(c => c.text ?? '')
    .join(' ');
}

function classify(line) {
  if (line.type === 'message') {
    if (line.role === 'user') return 'user_message';
    const s = line.status ?? '';
    if (s === 'generating' || s === 'in_progress') return 'assistant_generating';
    if (s === 'completed') return 'assistant_done';
    return 'assistant_other';
  }
  if (line.type === 'function_call') return 'tool_call';
  if (line.type === 'function_call_result') return 'tool_result';
  if (line.type === 'ai-title' || line.type === 'custom-title') return 'title';
  if (line.type === 'session-meta') return 'meta';
  return 'other';
}

function handleLine(key, line) {
  const st = tracked.get(key);
  const ts = typeof line.timestamp === 'number' ? line.timestamp : Date.now();
  st.session.lastTs = Math.max(st.session.lastTs, ts);
  st.session.lastLineId = line.id ?? st.session.lastLineId;

  switch (classify(line)) {
    case 'user_message': {
      const p = previewOf(line);
      if (p) emit('session.activity', st.session, { lastEvent: 'user_message', preview: p });
      break;
    }
    case 'assistant_generating':
      st.session.state = 'running';
      emit('session.activity', st.session, { lastEvent: 'assistant_generating' });
      break;
    case 'assistant_done': {
      const p = previewOf(line);
      st.session.state = 'turn_ended';
      st.session.completedAt = ts;
      emit('session.activity', st.session, { lastEvent: 'assistant_done', preview: p });
      break;
    }
    case 'tool_call':
      st.session.state = 'running';
      break;
    case 'title':
      st.session.title = line.aiTitle ?? line.customTitle ?? st.session.title;
      break;
    case 'meta':
      if (line.sessionId) st.session.sessionId = line.sessionId;
      break;
  }
}

function readNewLines(key, filePath, fromOffset, buf) {
  const fh = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fh).size;
    if (size <= fromOffset) return size;
    const len = size - fromOffset;
    const chunk = Buffer.alloc(len);
    fs.readSync(fh, chunk, 0, len, fromOffset);
    buf.append(chunk);
    // 只消费完整行，半行留到下一轮
    const full = buf.takeCompleteLines();
    for (const text of full) {
      let line;
      try { line = JSON.parse(text); } catch { continue; }
      handleLine(key, line);
    }
    return size;
  } finally {
    fs.closeSync(fh);
  }
}

class LineBuf {
  constructor() { this.str = ''; }
  append(chunk) { this.str += chunk.toString('utf8'); }
  takeCompleteLines() {
    const out = [];
    let idx;
    while ((idx = this.str.indexOf('\n')) >= 0) {
      const line = this.str.slice(0, idx).replace(/\r$/, '');
      this.str = this.str.slice(idx + 1);
      if (line) out.push(line);
    }
    return out;
  }
}

function listTranscripts() {
  let out = [];
  let workspaces;
  try { workspaces = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }); }
  catch { return out; }
  for (const ws of workspaces) {
    if (!ws.isDirectory()) continue;
    const dir = path.join(PROJECTS_DIR, ws.name);
    let files;
    try { files = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue; // 排除目录和 *.file-rollback.ndjson
      const p = path.join(dir, f.name);
      out.push({ key: `${ws.name}/${f.name}`, path: p });
    }
  }
  return out;
}

function emit(type, session, extra = {}) {
  console.log(JSON.stringify({
    type,
    agent: AGENT,
    sessionId: session.sessionId,
    cwd: session.cwd,
    title: session.title,
    state: session.state,
    lastTs: new Date(session.lastTs).toISOString(),
    ...extra,
  }));
}

function sweepIdle() {
  const now = Date.now();
  for (const st of tracked.values()) {
    if (st.session.state === 'turn_ended' && now - st.session.completedAt >= QUIET_MS) {
      st.session.state = 'idle';
      emit('session.state', st.session, { note: '启发式：末条回复完成后静默，判定为空闲（推测）' });
    }
  }
}

// ---------- 主循环 ----------
console.error(`[probe] 轮询 ${PROJECTS_DIR} 每 ${INTERVAL_MS / 1000}s，静默 ${QUIET_MS / 1000}s 判 idle，运行 ${DURATION_MS / 1000}s`);

const start = Date.now();
while (DURATION_MS === 0 || Date.now() - start < DURATION_MS) {
  for (const { key, path: p } of listTranscripts()) {
    if (!tracked.has(key)) {
      tracked.set(key, { offset: 0, session: { sessionId: key, cwd: null, title: null, state: 'unknown', lastTs: 0 }, buf: new LineBuf() });
      // 首次见到：从头读，静默登记（不打活动事件，避免历史刷屏）
      const st = tracked.get(key);
      st.offset = readAllInitial(p, st);
      // 按 jsonl 内部最后时间戳过滤旧会话（mtime 会被 WorkBuddy 迁移触碰，不可靠）
      if (Date.now() - st.session.lastTs > RECENT_DAYS * 86400_000) {
        tracked.delete(key);
        continue;
      }
      emit('session.registered', st.session, { note: '首次发现，静默登记历史' });
    }
    const st = tracked.get(key);
    try {
      st.offset = readNewLines(key, p, st.offset, st.buf);
    } catch { /* 文件可能被清理，下轮再看 */ }
  }
  sweepIdle();
  await new Promise(r => setTimeout(r, INTERVAL_MS));
}

function readAllInitial(p, st) {
  const size = fs.statSync(p).size;
  const fh = fs.openSync(p, 'r');
  try {
    const chunk = Buffer.alloc(size);
    fs.readSync(fh, chunk, 0, size, 0);
    st.buf.append(chunk);
    for (const text of st.buf.takeCompleteLines()) {
      let line;
      try { line = JSON.parse(text); } catch { continue; }
      // 静默登记：只更新元数据，不 emit 活动
      const ts = typeof line.timestamp === 'number' ? line.timestamp : Date.now();
      st.session.lastTs = Math.max(st.session.lastTs, ts);
      if (line.type === 'session-meta' && line.sessionId) st.session.sessionId = line.sessionId;
      if (line.type === 'ai-title' || line.type === 'custom-title') st.session.title = line.aiTitle ?? line.customTitle ?? st.session.title;
      if (line.cwd && !st.session.cwd) st.session.cwd = line.cwd;
      if (line.type === 'message') {
        if (line.status === 'generating' || line.status === 'in_progress') st.session.state = 'running';
        else if (line.status === 'completed') { st.session.state = 'turn_ended'; st.session.completedAt = ts; }
      }
    }
    return size;
  } finally { fs.closeSync(fh); }
}

// 汇总
console.error('\n[probe] ===== 会话快照 =====');
for (const st of tracked.values()) {
  const s = st.session;
  console.error(`[probe] ${s.sessionId}  state=${s.state}  title=${s.title ?? '(无)'}  cwd=${s.cwd ?? '(无)'}  last=${new Date(s.lastTs).toLocaleTimeString()}`);
}
console.error(`[probe] 共登记 ${tracked.size} 个会话`);
