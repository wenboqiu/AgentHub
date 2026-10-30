#!/usr/bin/env bash
# AgentHub：把 Claude Code hook 事件转发给本机 AgentHub。绝不能输出到 stdout，失败也要 exit 0
pid=$(cat /proc/$$/winpid 2>/dev/null || echo 0)
curl -s -o /dev/null --noproxy '*' --connect-timeout 0.3 -m 2 -X POST -H 'Content-Type: application/json' \
  --data-binary @- "http://127.0.0.1:47821/claude?pid=${pid}" >/dev/null 2>&1
exit 0
