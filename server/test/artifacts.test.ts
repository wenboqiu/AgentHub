import assert from 'node:assert/strict'
import test from 'node:test'
import { artifactPath, renderArtifact, summarize, type ArtifactInput } from '../src/artifacts.ts'

const base: ArtifactInput = {
  title: '修好登录回跳',
  status: '待验收',
  project: 'AgentHub',
  agent: 'claude',
  machine: 'pc-home',
  cwd: 'D:/Work2/AgentHub',
  sessionTitle: '登录回跳排查',
  doneAt: '2026/11/5 20:30:00',
  lastReply: '把 state 存在 cookie 里了，回跳参数现在能对上。',
  evidence: [],
  checklist: [],
  runs: [],
}

test('产物：六个小节齐全，材料缺失时写明待补而不是留空', () => {
  const md = renderArtifact(base)
  for (const h of ['## 做了什么', '## 怎么验证', '## 影响面', '## 验收要点', '## 后续', '## 风险与未决']) {
    assert.ok(md.includes(h), `缺少 ${h}`)
  }
  assert.ok(md.includes('把 state 存在 cookie 里'))
  assert.ok(md.includes('没有从会话里摘到命令'))
  assert.ok(md.includes('没有测试证据'))
})

test('产物：证据按类型分组，文件清单进入影响面', () => {
  const md = renderArtifact({
    ...base,
    evidence: [
      { kind: 'file', label: '文件变更', value: 'src/auth.ts', at: null },
      { kind: 'test', label: '测试结果', value: 'node --test 12 passed', at: null },
    ],
    checklist: [{ text: '回跳地址带 state', done: true }, { text: '过期 state 被拒绝', done: false }],
  })
  assert.ok(md.includes('- 文件：`src/auth.ts`'))
  assert.ok(md.includes('- 测试：`node --test 12 passed`'))
  assert.ok(md.includes('- [x] 回跳地址带 state'))
  assert.ok(md.includes('- [ ] 过期 state 被拒绝'))
  assert.ok(md.includes('未完成：过期 state 被拒绝'))
  // 有测试证据时不再提示回归风险未知
  assert.ok(!md.includes('没有测试证据'))
})

test('产物：失败的执行进风险段，停止也算', () => {
  const md = renderArtifact({
    ...base,
    runs: [{ status: 'failed', error: 'exit 1' }, { status: 'stopped', error: '' }],
    evidence: [{ kind: 'test', label: '测试结果', value: 'ok', at: null }],
  })
  assert.ok(md.includes('有 失败 的执行：exit 1'))
  assert.ok(md.includes('有 已停止 的执行'))
})

test('近况摘要：取第一句完整的话并封顶', () => {
  // 第一句太短（「改好了。」）就再拼一句，短句单独进简报没有信息量
  assert.equal(summarize('改好了。还顺手修了另一个 bug。', '兜底'), '改好了。还顺手修了另一个 bug。')
  assert.equal(summarize('把 state 挪进 cookie 之后，回跳参数能对上了。顺手补了两条测试。', '兜底'), '把 state 挪进 cookie 之后，回跳参数能对上了。')
  assert.equal(summarize('', '兜底一句'), '兜底一句')
  const long = summarize('一'.repeat(300), '兜底', 40)
  assert.equal(long.length, 40)
  assert.ok(long.endsWith('…'))
})

test('近况摘要：代码块不进入简报（免得把实现贴进上下文）', () => {
  assert.equal(summarize('改了这段：\n```ts\nconst a = 1\n```\n然后是结论。', '兜底'), '改了这段： 然后是结论。')
})

test('导出文件名：id + slug，中文保留，特殊字符变连字符', () => {
  assert.equal(artifactPath(12, '修好登录回跳'), 'docs/tasks/12-修好登录回跳.md')
  assert.equal(artifactPath(7, 'Fix: login / redirect!'), 'docs/tasks/7-fix-login-redirect.md')
  assert.equal(artifactPath(9, '!!!'), 'docs/tasks/9-task.md')
})
