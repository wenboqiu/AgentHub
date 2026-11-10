import { test } from 'node:test';
import assert from 'node:assert/strict';
import { machineTag, pickMachine } from '../src/lib/machines.ts';
import type { Machine } from '../src/lib/api.ts';

const m = (name: string, online: boolean, agents: string[]): Machine =>
  ({ name, online, at: null, agents });

test('按工具过滤候选：明确没装的不列，没上报过的放行', () => {
  const pick = pickMachine({
    machines: [m('A', true, ['claude']), m('B', true, ['codex']), m('C', true, []), m('D', false, ['claude'])],
    online: ['A', 'B', 'C'],
    stored: null,
    tool: 'claude',
  });
  assert.deepEqual(pick.usable.map(c => c.name), ['A', 'C', 'D']);
  // 四台都在候选里：下拉要把没装的那台标出来，不能装作看不见
  assert.deepEqual(pick.candidates.map(c => c.name), ['A', 'B', 'C', 'D']);
});

test('没定工具就不按工具过滤', () => {
  const pick = pickMachine({ machines: [m('A', true, ['claude']), m('B', true, ['codex'])], online: ['A', 'B'], stored: null, tool: null });
  assert.deepEqual(pick.usable.map(c => c.name), ['A', 'B']);
});

test('能跑的只有一台在线且任务没存机器：自动选它', () => {
  const pick = pickMachine({ machines: [m('A', true, ['claude']), m('B', false, ['claude'])], online: ['A'], stored: null, tool: 'claude' });
  assert.equal(pick.machine, 'A');
  assert.equal(pick.offline, false);
});

test('能跑的有多台在线就不瞎猜，等人选', () => {
  const pick = pickMachine({ machines: [m('A', true, ['claude']), m('B', true, ['claude'])], online: ['A', 'B'], stored: null, tool: 'claude' });
  assert.equal(pick.machine, '');
});

test('任务上存着的机器优先，哪怕它没装现在的工具也要留在下拉里', () => {
  const pick = pickMachine({ machines: [m('A', true, ['claude']), m('B', true, ['codex'])], online: ['A', 'B'], stored: 'B', tool: 'claude' });
  assert.equal(pick.machine, 'B');
  assert.equal(pick.machineLacks, true);
  assert.deepEqual(pick.options.map(c => c.name), ['A', 'B']);
  assert.deepEqual(pick.usable.map(c => c.name), ['A']);
});

test('选中的电脑离线：不拦，派活时入队等它上线', () => {
  const pick = pickMachine({ machines: [m('A', false, ['claude'])], online: [], stored: 'A', tool: 'claude' });
  assert.equal(pick.machine, 'A');
  assert.equal(pick.offline, true);
});

test('/machines 还没拉回时就退回在线名单，老电脑端算「不知道」不算没装', () => {
  const pick = pickMachine({ machines: [], online: ['老电脑'], stored: '老电脑', tool: 'claude' });
  assert.deepEqual(pick.usable.map(c => c.name), ['老电脑']);
  assert.equal(pick.machineLacks, false);
  assert.equal(pick.offline, false);
});

test('任务上存的机器这次没连上、也不在清单里：仍然留在下拉里', () => {
  const pick = pickMachine({ machines: [m('A', true, ['claude'])], online: ['A'], stored: '旧电脑', tool: 'claude' });
  assert.deepEqual(pick.options.map(c => c.name), ['A', '旧电脑']);
  assert.equal(pick.offline, true);
});

test('开着 AgentHub 但没开远程执行：算 offline（会排队），但单独标出来，不和真离线混在一起', () => {
  const pick = pickMachine({
    machines: [m('A', true, ['claude']), { ...m('B', false, ['claude']), listening: true }, m('C', false, [])],
    online: ['A'],
    stored: 'B',
    tool: 'claude',
  });
  assert.equal(pick.machine, 'B');
  assert.equal(pick.offline, true);
  assert.equal(pick.listening, true);
  assert.equal(machineTag(pick.candidates.find(c => c.name === 'A')!), '');
  assert.equal(machineTag(pick.candidates.find(c => c.name === 'B')!), '（开着，没开远程执行）');
  assert.equal(machineTag(pick.candidates.find(c => c.name === 'C')!), '（离线）');
  // 老服务端不给 listening：照旧按离线
  const old = pickMachine({ machines: [m('B', false, [])], online: [], stored: 'B', tool: null });
  assert.equal(old.listening, false);
});
