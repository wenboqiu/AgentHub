import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeEventMessages, sameKey, sameText } from '../server/src/message-merge.ts';

const T = Date.parse('2026-11-08T03:19:01.836Z');

test('正文归一化：transcript 折行与原文认作同一句', () => {
  const typed = '第一行\n第二行\n\n  第三行  ';
  assert.equal(sameText(typed), '第一行 第二行 第三行');
  assert.equal(sameKey(typed), sameKey('第一行 第二行 第三行'));
});

test('本次 run 自己发出去的用户消息：回显晚几秒、被折成一行也认得出', () => {
  // 用户在 AgentHub 里发的多行消息（库里已有，带 run_id）
  const echoes = ['调研一下 super agent\n和现在的实现差在哪'];
  // transcript 回显：折成一行，时间晚 6 秒（CLI 启动后才落盘）
  const incoming = [{ role: 'user', text: '调研一下 super agent 和现在的实现差在哪', at: T + 6_000 }];
  assert.deepEqual(mergeEventMessages(incoming, [], echoes), []);
});

test('同一句话说了两遍：回显只吃掉一条，第二遍照常入库', () => {
  const incoming = [
    { role: 'user', text: '继续', at: T },
    { role: 'user', text: '继续', at: T + 60_000 },
  ];
  const fresh = mergeEventMessages(incoming, [], ['继续']);
  assert.deepEqual(fresh.map(m => m.at), [T + 60_000]);
});

test('重发一条很旧的消息：不受「最近 N 条」窗口影响，按时间就近认得出', () => {
  const known = [{ role: 'assistant', text: '串口情况变了：现在出现的是 CH343', at: T }];
  // 执行器重启后重新回放，同一条正文、同一毫秒
  assert.deepEqual(mergeEventMessages([{ role: 'assistant', text: '串口情况变了：现在出现的是 CH343', at: T }], known, []), []);
  // 时间差在容差内（写入先后抖几百毫秒）也算同一条
  assert.deepEqual(mergeEventMessages([{ role: 'assistant', text: '串口情况变了：现在出现的是 CH343', at: T + 900 }], known, []), []);
  // 差得远就是新的一条（真的又回复了同样的话）
  assert.equal(mergeEventMessages([{ role: 'assistant', text: '串口情况变了：现在出现的是 CH343', at: T + 60_000 }], known, []).length, 1);
});

test('同一条事件里的重复行只入一条', () => {
  const incoming = [
    { role: 'assistant', text: '好了', at: T },
    { role: 'assistant', text: '好了', at: T },
  ];
  assert.equal(mergeEventMessages(incoming, [], []).length, 1);
});

test('角色不同不能互相抵消：用户说的和助手说的同文各入各的', () => {
  const known = [{ role: 'user', text: '开工', at: T }];
  const fresh = mergeEventMessages([{ role: 'assistant', text: '开工', at: T }], known, []);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].role, 'assistant');
});

test('长消息按前 400 字比对：电脑端 4000 字上限与历史全文不会被当成两条', () => {
  const head = '长'.repeat(400);
  const echoes = [head + '尾巴'.repeat(3000)];
  const incoming = [{ role: 'user', text: head + '尾巴'.repeat(100), at: T + 5_000 }];
  assert.deepEqual(mergeEventMessages(incoming, [], echoes), []);
});
