#!/usr/bin/env node
// 快通知通道：每 2 分钟探测一次有没有新任务单，有就弹一条系统通知，不花模型额度、不动任务状态。
// 真正的接手执行由 WorkBuddy 的「AgentHub 任务单监听（自动接手）」定时任务做（小时级）。
//
//   node scripts/notify-tasks.mjs           # 探测 + 通知 + 记日志
//   node scripts/notify-tasks.mjs --dry     # 只探测，不通知
//
// 由 ~/Library/LaunchAgents/top.wondergarden.agenthub.tasknotify.plist 每 120 秒拉起。

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const STATE_DIR = join(homedir(), '.agenthub', 'watcher')
const NOTIFIED_PATH = join(STATE_DIR, 'notified.json')
const LOG_PATH = join(STATE_DIR, 'notify.log')
const dry = process.argv.includes('--dry')

mkdirSync(STATE_DIR, { recursive: true })
const readJson = (path, fallback) => {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return fallback }
}
const log = line => appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`)

let out
try {
  out = execFileSync(process.execPath, [join(HERE, 'watch-tasks.mjs'), '--detect'], {
    encoding: 'utf8',
    timeout: 30_000,
  })
} catch (err) {
  log(`探测失败: ${err.message.split('\n')[0]}`)
  process.exit(0) // launchd 里失败不刷屏，记一笔就行
}

let data
try { data = JSON.parse(out) } catch {
  log(`输出解析失败: ${out.slice(0, 200)}`)
  process.exit(0)
}

if (data.busy) { log('上一轮还在跑，跳过'); process.exit(0) }

const seen = readJson(NOTIFIED_PATH, { ids: [] })
const seenIds = new Set(seen.ids ?? [])
const fresh = (data.candidates ?? []).filter(c => !seenIds.has(c.id))

if (!fresh.length) process.exit(0)

const summary = fresh.length === 1
  ? fresh[0].title
  : `${fresh.length} 张新单：${fresh.slice(0, 2).map(c => c.title).join('、')}${fresh.length > 2 ? ' 等' : ''}`

if (!dry) {
  const body = fresh.map(c => `#${c.id} ${c.title}（${c.priority}）`).join('\n')
  try {
    execFileSync('/usr/bin/osascript', [
      '-e',
      `display notification ${JSON.stringify(body)} with title "AgentHub 新任务单" subtitle ${JSON.stringify(summary)} sound name "Glass"`,
    ], { timeout: 10_000 })
  } catch (err) {
    log(`通知发送失败: ${err.message.split('\n')[0]}`)
  }
  for (const c of fresh) seenIds.add(c.id)
  // 只保留最近 200 条，账本别无限长
  writeFileSync(NOTIFIED_PATH, JSON.stringify({ ids: [...seenIds].slice(-200), updatedAt: new Date().toISOString() }, null, 2) + '\n')
}

log(`新单 ${fresh.map(c => c.id).join(',')} | ${summary}${dry ? ' | dry' : ''}`)
console.log(JSON.stringify({ notified: fresh.map(c => ({ id: c.id, title: c.title, priority: c.priority, dir: c.dir })), summary }, null, 2))
