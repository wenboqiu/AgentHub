import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldRepeats } from '../src/lib/foldRepeats.ts';
import type { Message } from '../src/lib/api.ts';

let n = 0;
const msg = (role: Message['role'], text: string, runId = 'r1'): Message =>
  ({ id: ++n, sessionId: 's', runId, role, text, createdAt: new Date(n * 1000).toISOString() }) as Message;

test('相邻相同的授权消息折成一条并计数；隔开的、不同运行的、人说的话都不折', () => {
  const ask = '请求授权：Bash {"command":"git diff"}';
  const ok = '已允许：Bash {"command":"git diff"}';
  const list = [
    msg('approval', ask), msg('approval', ask), msg('approval', ask),
    msg('approval', ok), msg('approval', ok),
    msg('assistant', '好'), msg('assistant', '好'),
    msg('approval', ask),
    msg('approval', ask, 'r2'),
  ];
  const out = foldRepeats(list).map(x => [x.m.role, x.m.text.slice(0, 2), x.count]);
  assert.deepEqual(out, [
    ['approval', '请求', 3],
    ['approval', '已允', 2],
    ['assistant', '好', 1],
    ['assistant', '好', 1],
    ['approval', '请求', 1],
    ['approval', '请求', 1],
  ]);
  // 保留第一条（时间、id 用最早那条）
  assert.equal(foldRepeats(list)[0].m.id, list[0].id);
});
