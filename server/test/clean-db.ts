// 测试库清理：删掉历次运行留下的测试账号（sessions / runs / messages 等都级联删除）。
// 不清的话，残留的 running 会话会积在 watchdog 的扫描窗口里（stalledSessions 每轮只取
// 最老的 50 条），把 notify / watchdog 等套件的广播等拖到超时。npm test 前自动跑一次。
import pg from 'pg'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:dev@localhost:55433/agenthub'
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 })
try {
  const r = await pool.query("DELETE FROM users WHERE email LIKE '%@test.dev'")
  if (r.rowCount) console.log(`clean-db: 删除 ${r.rowCount} 个测试账号及其级联数据`)
} finally {
  await pool.end()
}
