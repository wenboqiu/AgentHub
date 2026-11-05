import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBus, syncSession } from '../src/lib/sessionSync.ts';
import type { Message, Run } from '../src/lib/api.ts';

const time = '2026-10-31T00:00:00Z';
const message = (id: number): Message => ({ id, sessionId: 's', runId: 'r', role: 'assistant', text: `m${id}`, createdAt: time });
const run = (status: Run['status']): Run => ({ id: 'r', sessionId: 's', machine: 'pc', status, error: '', createdAt: time, updatedAt: time });
const snapshot = (ids: number[], status: Run['status']) => ({ messages: ids.map(message), run: run(status), approvals: [] });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
test('评价广播更新已有回复，慢快照不能覆盖新评价', async()=>{
  const s=setup();const initial=s.sync.reload();
  s.pending.shift()!(snapshot([1],'done'));await initial;
  const reload=s.sync.reload();
  s.bus.emit({kind:'message',m:{...message(1),sourceId:'native-message',rating:'up'}});
  s.pending.shift()!(snapshot([1],'done'));await reload;
  assert.equal(s.states.at(-1)?.messages.length,1);
  assert.equal(s.states.at(-1)?.messages[0].rating,'up');s.sync.dispose();
});
function snapshotData(ids: number[], status: Run['status']) {
  const { messages, run } = snapshot(ids, status);
  return { messages, run, activity: null };
}

function setup() {
  const bus = makeBus();
  const pending: ((value: ReturnType<typeof snapshot>) => void)[] = [];
  const states: { messages: Message[]; run: Run | null }[] = [];
  const errors: unknown[] = [];
  const sync = syncSession({ messages: () => new Promise(resolve => pending.push(resolve)) }, 's', bus,
    data => states.push(data), error => errors.push(error), () => {});
  return { bus, pending, states, errors, sync };
}

test('重连补回断线期间消息和最终运行状态', async () => {
  const s = setup();
  const initial = s.sync.reload();
  s.pending.shift()!(snapshot([1], 'running'));
  await initial;
  s.bus.emit({ kind: 'resync' });
  s.pending.shift()!(snapshot([1, 2], 'done'));
  await tick();
  assert.deepEqual(s.states.at(-1), snapshotData([1, 2], 'done'));
  s.sync.dispose();
});

test('慢快照不能覆盖请求期间的新消息和同毫秒终态，消息去重', async () => {
  const s = setup();
  const loading = s.sync.reload();
  s.bus.emit({ kind: 'message', m: message(2) });
  s.bus.emit({ kind: 'message', m: message(2) });
  s.bus.emit({ kind: 'run', r: run('done') });
  s.pending.shift()!(snapshot([1, 2], 'running'));
  await loading;
  s.bus.emit({ kind: 'run', r: run('running') });
  assert.deepEqual(s.states.at(-1), snapshotData([1, 2], 'done'));
  s.sync.dispose();
});

test('运行状态只贴当前这次 run：换轮次清空，idle 清空，别人的不认', async () => {
  const s = setup();
  const loading = s.sync.reload();
  s.pending.shift()!(snapshot([1], 'running'));
  await loading;
  const act = (runId: string, kind: 'thinking' | 'tool' | 'idle', text: string) =>
    ({ runId, sessionId: 's', kind, text, at: time });
  s.bus.emit({ kind: 'activity', a: act('r', 'thinking', '先看解析') });
  assert.equal(s.states.at(-1)?.activity?.text, '先看解析');
  s.bus.emit({ kind: 'activity', a: act('other', 'tool', 'npm test') });
  assert.equal(s.states.at(-1)?.activity?.text, '先看解析', '别的 run 的状态不能串过来');
  s.bus.emit({ kind: 'activity', a: act('r', 'idle', '') });
  assert.equal(s.states.at(-1)?.activity, null);
  s.bus.emit({ kind: 'activity', a: act('r', 'tool', 'npm test') });
  s.bus.emit({ kind: 'run', r: { ...run('running'), id: 'r2', createdAt: '2026-10-31T00:01:00Z' } });
  assert.equal(s.states.at(-1)?.activity, null, '换了一轮就不该留着上一轮的话');
  s.sync.dispose();
});

test('较早请求迟到时不能覆盖较新快照，离开详情页后不再更新', async () => {
  const s = setup();
  const first = s.sync.reload();
  const second = s.sync.reload();
  s.pending[1](snapshot([1, 2], 'done'));
  await second;
  s.pending[0](snapshot([1], 'running'));
  await first;
  assert.deepEqual(s.states.at(-1), snapshotData([1, 2], 'done'));
  const third = s.sync.reload();
  const count = s.states.length;
  s.sync.dispose();
  s.pending[2](snapshot([1, 2, 3], 'done'));
  await third;
  s.bus.emit({ kind: 'resync' });
  assert.equal(s.states.length, count);
  assert.equal(s.pending.length, 3);
});
