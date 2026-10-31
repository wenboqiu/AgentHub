#!/usr/bin/env bash
# AgentHub：把 Claude Code hook 事件转发给本机 AgentHub。绝不能输出到 stdout，失败也要 exit 0
# 进程号：沿 MSYS 父链找到最外层的 bash（它的 Windows 父进程就是 claude.exe），
# 中间的 bash 在 Windows 上的父进程可能已经退出，不能直接用 $$ 的 winpid
p=$$
while pp=$(cat /proc/$p/ppid 2>/dev/null) && [ "$pp" != 1 ] && [ -r /proc/$pp/winpid ]; do p=$pp; done
pid=$(cat /proc/$p/winpid 2>/dev/null || echo 0)
curl -s -o /dev/null --noproxy '*' --connect-timeout 0.3 -m 2 -X POST -H 'Content-Type: application/json' \
  --data-binary @- "http://127.0.0.1:47821/claude?pid=${pid}" >/dev/null 2>&1
exit 0
