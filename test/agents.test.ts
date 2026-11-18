import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DISPATCHABLE_AGENTS, isListenOnly } from '../src/lib/agents.ts';

test('WorkBuddy 只做会话监听，不进派活候选', () => {
  // 桌面端内置的 lite-wb 没有独立登录态（实测 -p 直接 Authentication required），
  // 能自己 /login 的那份是 npm 完整版，也就是 CodeBuddy。两个入口都留在下拉里只会让人二选一选错。
  assert.equal(isListenOnly('workbuddy'), true);
  assert.ok(!DISPATCHABLE_AGENTS.includes('workbuddy'), 'WorkBuddy 不该出现在角色的执行工具下拉里');
  assert.ok(DISPATCHABLE_AGENTS.includes('codebuddy'), '派活走 CodeBuddy');
});

test('豆包仍然只做监听，CodeBuddy 可以被派活', () => {
  assert.equal(isListenOnly('doubao'), true);
  assert.ok(!DISPATCHABLE_AGENTS.includes('doubao'));
  assert.equal(isListenOnly('codebuddy'), false);
  assert.deepEqual(
    [...DISPATCHABLE_AGENTS].sort(),
    ['claude', 'codebuddy', 'codex', 'zcode'],
  );
});
