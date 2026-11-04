import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_IMAGES, MAX_IMAGE_CHARS, fitsLimit, pickDataUrls, pickImageFiles } from '../src/lib/images.ts';

/** 做一张指定长度的假图片 data URL */
const url = (chars = 100, mime = 'image/jpeg') => `data:${mime};base64,` + 'A'.repeat(Math.max(0, chars - 22));

/** pickImageFiles 只看 type，用最小对象冒充 File */
const file = (type: string) => ({ type }) as unknown as File;

test('挑出图片文件，非图片忽略', () => {
  const r = pickImageFiles([file('image/png'), file('text/plain'), file('image/jpeg')], 0);
  assert.equal(r.files.length, 2);
  assert.equal(r.error, '');
});

test('一个能用的都没有时给格式提示', () => {
  const r = pickImageFiles([file('text/plain'), file('application/pdf')], 0);
  assert.equal(r.files.length, 0);
  assert.match(r.error, /png/);
});

test('张数按剩余额度截断并提示', () => {
  const four = [file('image/png'), file('image/png'), file('image/png'), file('image/png')];
  const r = pickImageFiles(four, 2);
  assert.equal(r.files.length, 2, '只剩 2 张额度');
  assert.match(r.error, /最多附 4 张/);
});

test('额度用完时一张都不收', () => {
  const r = pickImageFiles([file('image/png')], MAX_IMAGES);
  assert.equal(r.files.length, 0);
  assert.match(r.error, /最多附 4 张/);
});

test('只收 png / jpeg / webp / gif', () => {
  const ok = pickImageFiles([file('image/gif'), file('image/webp')], 0);
  assert.equal(ok.files.length, 2);
  assert.equal(ok.error, '');
  // svg 不在白名单里：和 Claude/Codex 都不认的格式
  assert.equal(pickImageFiles([file('image/svg+xml')], 0).files.length, 0);
});

test('体积上限与服务端一致', () => {
  assert.equal(MAX_IMAGE_CHARS, 2_500_000);
  assert.equal(fitsLimit('data:image/png;base64,' + 'A'.repeat(100)), true);
  assert.equal(fitsLimit('data:image/png;base64,' + 'A'.repeat(MAX_IMAGE_CHARS)), false, '超一个字符就不收');
});

test('原生相册回来的图直接收下，没有提示', () => {
  const r = pickDataUrls([url(100), url(200, 'image/png')], 0);
  assert.equal(r.images.length, 2);
  assert.equal(r.error, '');
});

test('原生回来超过剩余额度时截断并提示', () => {
  const r = pickDataUrls([url(10), url(10), url(10)], 2);
  assert.equal(r.images.length, 2, '只剩 2 张额度');
  assert.match(r.error, /最多附 4 张/);
});

test('原生回来的图太大或者不是图片就跳过', () => {
  const big = 'data:image/jpeg;base64,' + 'A'.repeat(MAX_IMAGE_CHARS);
  const r = pickDataUrls([url(50), big, 'data:text/plain;base64,QQ=='], 0);
  assert.equal(r.images.length, 1);
  assert.match(r.error, /已跳过/);
});

test('额度已满时原生相册的结果一张都不收', () => {
  const r = pickDataUrls([url(50)], MAX_IMAGES);
  assert.equal(r.images.length, 0);
  assert.match(r.error, /最多附 4 张/);
});

test('用户取消选图（空数组）什么都不提示', () => {
  const r = pickDataUrls([], 1);
  assert.equal(r.images.length, 0);
  assert.equal(r.error, '');
});
