import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatElapsed, liveLabel, runElapsed, runSummary, shortTokens, usageText } from '../src/lib/runMeta.ts';
import type { Run, RunActivity } from '../src/lib/api.ts';

const now = Date.parse('2026-11-05T12:00:00Z');
const at = (ms: number) => new Date(now - ms).toISOString();

const run = (patch: Partial<Run> = {}): Run => ({
  id: 'r1', sessionId: 'claude:abc', taskId: null, title: '', machine: 'pc',
  status: 'done', error: '', usage: null, createdAt: at(83_000), updatedAt: at(0),
  ...patch,
});

test('token 数按人读的方式缩写', () => {
  assert.equal(shortTokens(0), '0');
  assert.equal(shortTokens(980), '980');
  assert.equal(shortTokens(1000), '1k');
  assert.equal(shortTokens(1240), '1.2k');
  assert.equal(shortTokens(12_400), '12.4k');
  assert.equal(shortTokens(1_400_000), '1.4M');
});

test('用时：秒 / 分秒 / 小时', () => {
  assert.equal(formatElapsed(0), '0 秒');
  assert.equal(formatElapsed(18_400), '18 秒');
  assert.equal(formatElapsed(83_000), '1 分 23 秒');
  assert.equal(formatElapsed(120_000), '2 分钟');
  assert.equal(formatElapsed(4_320_000), '1 小时 12 分');
});

test('跑完按起止时间算耗时，在跑就按到现在的算', () => {
  assert.equal(runElapsed(run()), 83_000);
  assert.equal(runElapsed(run({ status: 'running', updatedAt: at(60_000) }), now), 83_000);
  assert.equal(runElapsed(run({ createdAt: 'bad', updatedAt: 'bad' })), 0);
});

test('用完说明带缓存与小额的美元', () => {
  assert.equal(usageText({ input: 1240, output: 345, total: 1585 }), '输入 1.2k · 输出 345 tokens');
  assert.equal(
    usageText({ input: 1240, output: 345, cached: 8000, total: 9585, costUsd: 0.0421 }),
    '输入 1.2k · 输出 345 · 缓存 8k tokens · $0.042',
  );
  assert.equal(usageText({ input: 100, output: 20, total: 120, costUsd: 0.0042 }), '输入 100 · 输出 20 tokens · $0.0042');
});

test('收尾那一行：状态 + 用时 + 用量', () => {
  assert.equal(runSummary(run()), '本次完成 · 用时 1 分 23 秒');
  assert.equal(
    runSummary(run({ usage: { input: 1240, output: 345, total: 1585, costUsd: 0.0421 } })),
    '本次完成 · 用时 1 分 23 秒 · 输入 1.2k · 输出 345 tokens · $0.042',
  );
  assert.equal(runSummary(run({ status: 'stopped' })), '已停止 · 用时 1 分 23 秒');
  assert.equal(runSummary(run({ status: 'failed' })), '运行失败 · 用时 1 分 23 秒');
  // 没有用量（老电脑端、WorkBuddy 只读会话）就只说用时
  assert.ok(!runSummary(run()).includes('tokens'));
});

test('运行中的话术只说 agent 自己的内容', () => {
  const act = (kind: 'thinking' | 'tool' | 'text' | 'idle', text: string): RunActivity => ({
    runId: 'r1', sessionId: 'claude:abc', kind, text, at: at(1000),
  });
  assert.equal(liveLabel(act('thinking', '先看一下 runner 是怎么解析输出的'), 'Claude'), '思考：先看一下 runner 是怎么解析输出的');
  assert.equal(liveLabel(act('tool', 'npm run build'), 'Codex'), '执行：npm run build');
  assert.equal(liveLabel(act('text', '改完了，三处都看了'), 'ZCode'), '输出：改完了，三处都看了');
  // 换行和多余空格压成一行，超长截断
  assert.equal(liveLabel(act('thinking', '第一行\n  第二行'), 'Claude'), '思考：第一行 第二行');
  assert.equal(liveLabel(act('tool', 'x'.repeat(200)), 'Claude').length, '执行：'.length + 81);
  // 没有播报内容：只报等待，不编状态
  assert.equal(liveLabel(null, 'Claude'), '等待 Claude 回应');
  assert.equal(liveLabel(act('idle', ''), 'Codex'), '等待 Codex 回应');
  assert.equal(liveLabel(act('thinking', '   '), 'Claude'), '等待 Claude 回应');
});
