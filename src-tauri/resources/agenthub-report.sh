#!/usr/bin/env bash
# AgentHub：把 Claude Code hook 事件转发给本机 AgentHub。失败也要 exit 0
# 普通事件绝不输出 stdout；只有 PermissionRequest 会把本机 AgentHub 的响应体原样回给 Claude（空 = 不表态）
# 进程号：沿 MSYS 父链找到最外层的 bash（它的 Windows 父进程就是 claude.exe），
# 中间的 bash 在 Windows 上的父进程可能已经退出，不能直接用 $$ 的 winpid
p=$$
while pp=$(cat /proc/$p/ppid 2>/dev/null) && [ "$pp" != 1 ] && [ -r /proc/$pp/winpid ]; do p=$pp; done
pid=$(cat /proc/$p/winpid 2>/dev/null || echo 0)
input=$(cat)
case "$input" in
  *'"hook_event_name":"PermissionRequest"'*|*'"hook_event_name": "PermissionRequest"'*)
    # 阻塞等客户端上点「拒绝 / 允许」，-m 比客户端的等待时间（25 秒）多 5 秒
    out=$(printf '%s' "$input" | curl -s --noproxy '*' --connect-timeout 0.3 -m 30 -X POST -H 'Content-Type: application/json' \
      --data-binary @- "http://127.0.0.1:47821/claude-permission?pid=${pid}" 2>/dev/null)
    [ -n "$out" ] && printf '%s' "$out"
    ;;
  *)
    printf '%s' "$input" | curl -s -o /dev/null --noproxy '*' --connect-timeout 0.3 -m 2 -X POST -H 'Content-Type: application/json' \
      --data-binary @- "http://127.0.0.1:47821/claude?pid=${pid}" >/dev/null 2>&1
    ;;
esac
exit 0
