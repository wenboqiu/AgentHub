import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isStuckRunning, sendBlockReason, STALE_RUNNING_MS } from '../src/lib/sendBlock.ts';
import type { Session } from '../src/lib/api.ts';

const now = Date.parse('2026-11-04T15:00:00Z');
const at = (ms: number) => new Date(now - ms).toISOString();

const session = (patch: Partial<Session> = {}): Session => ({
  id: 'codex:abc',
  agent: 'codex',
  machine: 'pc',
  cwd: 'D:\\Work2\\AgentHub',
  project: 'AgentHub',
  title: 't',
  state: 'running',
  summary: '',
  stateSince: at(0),
  acked: true,
  pid: null,
  eventAt: at(0),
  updatedAt: at(0),
  ...patch,
});

test('Codex 正在跑（刚有事件）时不给发', () => {
  const s = session({ eventAt: at(60_000) });
  assert.equal(isStuckRunning(s, now), false);
  assert.equal(sendBlockReason({ session: s, agents: ['pc'], running: false }, now), '这个 Codex 会话正在 Desktop 里运行，等它结束后再发');
});

test('Codex 状态卡在 running 但久无事件：视为残留状态，允许发送', () => {
  const s = session({ eventAt: at(STALE_RUNNING_MS + 60_000) });
  assert.equal(isStuckRunning(s, now), true);
  assert.equal(sendBlockReason({ session: s, agents: ['pc'], running: false }, now), null);
});

test('阈值边界：刚好卡在时长内仍然拦着，超过才放行', () => {
  assert.equal(isStuckRunning(session({ eventAt: at(STALE_RUNNING_MS - 1000) }), now), false);
  assert.equal(isStuckRunning(session({ eventAt: at(STALE_RUNNING_MS + 1000) }), now), true);
});

test('非 running 状态、以及其它阻塞原因不受影响', () => {
  assert.equal(isStuckRunning(session({ state: 'done', eventAt: at(9e6) }), now), false);
  assert.equal(sendBlockReason({ session: session({ state: 'done' }), agents: ['pc'], running: false }, now), null);
  // 本机执行器真的在跑（AgentHub 自己发起的 run）仍然锁着
  assert.equal(sendBlockReason({ session: session({ state: 'done' }), agents: ['pc'], running: true }, now), '这个会话正在运行');
  // 电脑端不在线
  assert.equal(sendBlockReason({ session: session(), agents: [], running: false }, now), '电脑端不在线');
  // 只监听的 agent 永远不给发（WorkBuddy 已支持派活，现在只剩豆包只读）
  assert.match(String(sendBlockReason({ session: session({ agent: 'doubao', id: 'doubao:x' }), agents: ['pc'], running: false }, now)), /状态监听/);
});
