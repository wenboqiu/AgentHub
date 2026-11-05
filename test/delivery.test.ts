import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planDelivery } from '../src/lib/delivery.ts';
import type { ForkInfo } from '../src/lib/api.ts';

// 界面这一份只是预览：真正的判定在服务端，两边规则要一致，否则人会看到
// 「按钮亮着但派发后没用上」。这里守住的是「什么时候该灰、理由说不说得清」。

const fork = (patch: Partial<ForkInfo> = {}): ForkInfo => ({
  agent: 'claude', machine: 'pc-home', cwd: 'D:/Work2/AgentHub', ok: true, reason: '', ...patch,
});

const target = { agent: 'claude', machine: 'pc-home', cwd: 'D:/Work2/AgentHub' };

test('条件都对上：接着原会话', () => {
  const p = planDelivery('fork', fork(), target);
  assert.equal(p.mode, 'fork');
  assert.equal(p.blocked, false);
  assert.match(p.reason, /接着原会话/);
});

test('换了执行工具 / 电脑 / 目录：灰掉并说明为什么', () => {
  const agent = planDelivery('fork', fork(), { ...target, agent: 'codex' });
  assert.deepEqual([agent.mode, agent.blocked], ['fresh', true]);
  assert.match(agent.reason, /续不上/);

  const machine = planDelivery('fork', fork(), { ...target, machine: 'mac' });
  assert.equal(machine.blocked, true);
  assert.match(machine.reason, /换了电脑/);

  const cwd = planDelivery('fork', fork(), { ...target, cwd: 'D:/Work2/别的' });
  assert.equal(cwd.blocked, true);
  assert.match(cwd.reason, /任务目录/);
});

test('原会话本身不能续：直接给出它的理由', () => {
  const running = planDelivery('fork', fork({ ok: false, reason: '原会话还在跑，等它结束才能续' }), target);
  assert.equal(running.blocked, true);
  assert.match(running.reason, /还在跑/);
});

test('还没定执行人时不拦：交给服务端派发时再判', () => {
  const p = planDelivery('fork', fork(), { agent: '', machine: '', cwd: '' });
  assert.equal(p.mode, 'fork');
  assert.equal(p.blocked, false);
});

test('主动选从零开始：不做任何额外判断', () => {
  const p = planDelivery('fresh', fork({ ok: false, reason: 'x' }), target);
  assert.deepEqual([p.mode, p.blocked], ['fresh', false]);
});
