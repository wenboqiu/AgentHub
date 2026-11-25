import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isInternalSession, sessionPreview } from '../src/lib/internal.ts';
import type { Session } from '../src/lib/api.ts';

const session = (patch: Partial<Session> = {}): Session => ({
  id: 'codebuddy:abc',
  agent: 'codebuddy',
  machine: 'pc',
  cwd: 'D:\\Work2\\AgentHub',
  project: 'AgentHub',
  title: 't',
  state: 'running',
  summary: '',
  stateSince: '2026-11-08T03:00:00.000Z',
  acked: true,
  pid: null,
  eventAt: '2026-11-08T03:00:00.000Z',
  updatedAt: '2026-11-08T03:00:00.000Z',
  ...patch,
});

test('内部会话按服务端前缀认出来（角色助手 / 意见细化），普通会话不算', () => {
  assert.equal(isInternalSession(session({ title: '意见细化：修好会话列表的标题' })), true);
  assert.equal(isInternalSession(session({ title: '角色助手：造一个后端' })), true);
  assert.equal(isInternalSession(session({ title: '修好会话列表的标题' })), false);
  assert.equal(isInternalSession(session({ title: '' })), false);
});

test('kind 字段优先：标题被契约提示词顶掉的内部会话也能认出来', () => {
  assert.equal(isInternalSession(session({ kind: 'internal', title: '你在 AgentHub 里当项目经理，负责…' })), true);
  // 老数据没有 kind：仍然走标题前缀兜底
  assert.equal(isInternalSession(session({ title: '普通会话' })), false);
});

test('列表副标题：有标题用标题，没有才退回最后一句话', () => {
  assert.equal(sessionPreview(session({ title: '修好标题', summary: '好的，我看下' })), '修好标题');
  assert.equal(sessionPreview(session({ title: '', summary: '好的，我看下' })), '好的，我看下');
});

test('列表副标题吞掉 JSON / 代码块：那是 agent 回的草稿，不是给人看的摘要', () => {
  assert.equal(sessionPreview(session({ title: '', summary: '{"title":"修好标题","priority":"high"}' })), '');
  assert.equal(sessionPreview(session({ title: '', summary: '```json\n{"skip":true}\n```' })), '');
  assert.equal(sessionPreview(session({ title: '', summary: '   ' })), '');
});
