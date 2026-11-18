import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachmentId, fileKind, formatSize, notesForAgent, refOf, refsInNotes } from '../src/lib/attachments.ts';
import type { Attachment } from '../src/lib/api.ts';

const att = (id: number, kind: Attachment['kind'], name: string, size = 1024): Attachment =>
  ({ id, taskId: 1, kind, name, mime: kind === 'image' ? 'image/png' : 'application/pdf', size, createdAt: '2026-11-07T00:00:00.000Z', url: kind === 'image' ? 'data:image/png;base64,AA' : null });

test('引用写法：图片用 ![]，文件用 []', () => {
  assert.equal(refOf({ id: 3, name: '截图 1.png', kind: 'image' }), '![截图 1.png](attachment:3)');
  assert.equal(refOf({ id: 4, name: '需求.pdf', kind: 'file' }), '[需求.pdf](attachment:4)');
});

test('从 src/href 认附件 id，普通链接一律不认', () => {
  assert.equal(attachmentId('attachment:12'), 12);
  assert.equal(attachmentId(' attachment:7 '), 7);
  for (const bad of ['attachment:', 'attachment:abc', 'attachment:0x1', 'https://x/attachment:1', '', undefined, null])
    assert.equal(attachmentId(bad as string | undefined), null);
});

test('大小格式：字节 / KB / MB', () => {
  assert.equal(formatSize(0), '0 B');
  assert.equal(formatSize(512), '512 B');
  assert.equal(formatSize(2048), '2 KB');
  assert.equal(formatSize(1024 * 1024), '1.0 MB');
  assert.equal(formatSize(12 * 1024 * 1024), '12 MB');
});

test('后缀标签：有后缀用后缀，没有就用 MIME 尾部', () => {
  assert.equal(fileKind('设计稿.PSD', 'image/vnd.adobe.photoshop'), 'PSD');
  assert.equal(fileKind('noext', 'application/pdf'), 'PDF');
  assert.equal(fileKind('x', ''), 'FILE');
});

test('备注里引用了哪些附件：只认完整引用，裸写 id 当普通文字', () => {
  const notes = '先看 ![a](attachment:1)，再看 [b](attachment:2)，同一张再提一次 ![a](attachment:1)';
  assert.deepEqual(refsInNotes(notes), [1, 2]);
  // 讨论这个功能本身（不是引用）不该被当成引用去校验
  assert.deepEqual(refsInNotes('备注里写 attachment:99 这种语法是什么意思'), []);
  assert.deepEqual(refsInNotes(''), []);
});

test('发给执行者时引用换成附件名，并说明附件没随任务发送', () => {
  const list = [att(1, 'image', '首页.png'), att(2, 'file', '需求.pdf')];
  const out = notesForAgent('改一下 ![首页](attachment:1)，按 [需求](attachment:2) 来，还有一个 attachment:8', list);
  assert.match(out, /「首页\.png」（附件未随任务发送）/);
  assert.match(out, /「需求\.pdf」（附件未随任务发送）/);
  // 不能骗 agent「见截图」——它根本收不到图
  assert.doesNotMatch(out, /见截图/);
  // 裸写的 id 原样保留（那是正文，不是引用）
  assert.match(out, /attachment:8/);
  assert.doesNotMatch(out, /attachment:1/);
});

test('引用里的文字兜底：附件找不到时用 caption', () => {
  assert.equal(notesForAgent('![旧截图](attachment:5)', []), '「旧截图」（附件未随任务发送）');
});
