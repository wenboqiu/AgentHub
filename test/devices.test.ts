import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_STATE_LABEL, deviceSummary, deviceSummaryText, groupDevices, machineState } from '../src/lib/devices.ts';
import type { Machine } from '../src/lib/api.ts';

const m = (name: string, opts: Partial<Machine> = {}): Machine =>
  ({ name, online: false, at: null, agents: [], ...opts });

test('三种状态分开：只监听不算在线，老服务端没有 listening 字段就是离线', () => {
  assert.equal(machineState({ online: true }), 'online');
  assert.equal(machineState({ online: false, listening: true }), 'listening');
  assert.equal(machineState({ online: false }), 'offline');
  // 同时为真时以 online 为准：执行器连着就是能接活
  assert.equal(machineState({ online: true, listening: true }), 'online');
  assert.equal(DEVICE_STATE_LABEL.online, '在线');
});

test('按在线 / 只监听 / 离线分组，空组保留', () => {
  const groups = groupDevices([
    m('A', { online: true }),
    m('B', { listening: true }),
    m('C'),
    m('D', { online: true, listening: true }),
  ]);
  assert.deepEqual(groups.map((g) => g.key), ['online', 'listening', 'offline']);
  assert.deepEqual(groups[0].items.map((x) => x.name), ['A', 'D']);
  assert.deepEqual(groups[1].items.map((x) => x.name), ['B']);
  assert.deepEqual(groups[2].items.map((x) => x.name), ['C']);
  assert.deepEqual(groupDevices([]).map((g) => g.items.length), [0, 0, 0]);
});

test('组内最近活动在前，没有活动时间的排最后，同时间按名字', () => {
  const groups = groupDevices([
    m('no-at'),
    m('old', { at: '2026-11-01T00:00:00.000Z' }),
    m('new', { at: '2026-11-14T00:00:00.000Z' }),
    m('same-b', { at: '2026-11-10T00:00:00.000Z' }),
    m('same-a', { at: '2026-11-10T00:00:00.000Z' }),
  ]);
  assert.deepEqual(groups[2].items.map((x) => x.name), ['new', 'same-a', 'same-b', 'old', 'no-at']);
});

test('汇总与一级列表文案：只列出现过的状态', () => {
  const list = [m('A', { online: true }), m('B', { listening: true }), m('C'), m('D')];
  assert.deepEqual(deviceSummary(list), { online: 1, listening: 1, offline: 2 });
  assert.equal(deviceSummaryText(list), '1 台在线 · 1 台没开远程执行 · 2 台离线');
  assert.equal(deviceSummaryText([m('A', { online: true })]), '1 台在线');
});

test('还没拉到 / 一台都没有时给不同的话，别显示成 0 台在线', () => {
  assert.equal(deviceSummaryText(null), '加载中…');
  assert.equal(deviceSummaryText([]), '还没有电脑上报过');
});
