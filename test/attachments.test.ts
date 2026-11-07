import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachmentId, danglingRefs, fileKind, formatSize, notesForAgent, refOf } from '../src/lib/attachments.ts';
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

test('备注里引用了不存在的附件能被挑出来', () => {
  const list = [att(1, 'image', 'a.png'), att(2, 'file', 'b.pdf')];
  const notes = '先看 ![a](attachment:1)，再看 [b](attachment:2)';
  assert.deepEqual(danglingRefs(notes, list), []);
  assert.deepEqual(danglingRefs(`${notes}\n![c](attachment:9)\n[d](attachment:9)`, list), [9]);
});

test('发给执行者时引用换成附件名：attachment:ID 对 agent 没有意义', () => {
  const list = [att(1, 'image', '首页.png'), att(2, 'file', '需求.pdf')];
  const out = notesForAgent('改一下 ![首页](attachment:1)，按 [需求](attachment:2) 来，还有一个 attachment:8', list);
  assert.match(out, /见截图「首页\.png」/);
  assert.match(out, /「需求\.pdf」/);
  // 附件已经没了就退回引用里的文字，不留下一个空壳
  assert.match(out, /attachment:8/);
  assert.doesNotMatch(out, /attachment:1/);
});

test('引用里的文字兜底：附件找不到时用 caption', () => {
  assert.equal(notesForAgent('![旧截图](attachment:5)', []), '（见截图「旧截图」）');
});
