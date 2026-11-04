import pg from 'pg'
import { hashPassword, newAuthSession } from '../src/auth.ts'

export const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:dev@localhost:55433/agenthub'

let hash: Promise<string> | null = null
let n = 0
// 每个测试进程都会重新加载这个模块：只用毫秒时间戳会让并发启动的两个进程撞同一个邮箱
const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

export const PASSWORD = 'password123'

// 直接在库里建一个账号（密码 password123）并签一个设备会话 token，测试里不用走登录
export async function makeUser(pool: pg.Pool, device = 'test') {
  hash ??= hashPassword(PASSWORD)
  const email = `u${stamp}-${n++}@test.dev`
  const r = await pool.query('INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id', [email, await hash])
  const id = Number(r.rows[0].id)
  return { id, email, token: await newAuthSession(pool, id, device) }
}

export async function addDevice(pool: pg.Pool, userId: number, device: string) {
  const token = await newAuthSession(pool, userId, device)
  return token
}
