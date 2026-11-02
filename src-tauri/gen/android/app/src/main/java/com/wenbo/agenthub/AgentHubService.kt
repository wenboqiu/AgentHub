package com.wenbo.agenthub

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

/** 前台服务：保持到 AgentHub 服务端的 WebSocket，收到需要提醒的会话变化时弹本地通知 */
class AgentHubService : Service() {
  companion object {
    const val CH_SERVICE = "agenthub_service"
    const val CH_ALERTS = "agenthub_alerts"
    const val FG_ID = 1

    @Volatile
    var running = false

    fun prefs(ctx: Context): SharedPreferences = ctx.getSharedPreferences("agenthub", Context.MODE_PRIVATE)
  }

  private val handler = Handler(Looper.getMainLooper())
  private val client = OkHttpClient.Builder()
    .pingInterval(30, TimeUnit.SECONDS)
    .readTimeout(0, TimeUnit.MILLISECONDS)
    .build()
  private var ws: WebSocket? = null
  private var generation = 0
  private var backoff = 1000L
  private var connected = false
  private var stopped = false

  // 登录失效（握手 401 / 关闭码 4401）：停止重连，直到下次 start() 带来新 token
  private var authExpired = false
  private var activeToken = ""
  private var netCallback: ConnectivityManager.NetworkCallback? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    createChannels()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val p = prefs(this)
    if (!p.getBoolean("enabled", false) || p.getString("url", "").isNullOrBlank()) {
      // startForegroundService 之后必须调用 startForeground，否则会崩
      startForegroundCompat()
      stopSelf()
      return START_NOT_STICKY
    }
    // start() 每次都会重新进到这里：token 变了（重新登录）就放弃旧连接、清掉失效状态
    val token = p.getString("token", "") ?: ""
    if (authExpired || token != activeToken) {
      authExpired = false
      activeToken = token
      generation++
      ws?.cancel()
      ws = null
      connected = false
      backoff = 1000L
      handler.removeCallbacks(reconnect)
    }
    startForegroundCompat()
    running = true
    stopped = false
    if (ws == null) connect()
    registerNetwork()
    return START_STICKY
  }

  override fun onDestroy() {
    stopped = true
    running = false
    handler.removeCallbacksAndMessages(null)
    ws?.cancel()
    ws = null
    netCallback?.let {
      try {
        (getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager).unregisterNetworkCallback(it)
      } catch (e: Exception) {
        // 已经注销就忽略
      }
    }
    netCallback = null
    super.onDestroy()
  }

  private fun createChannels() {
    if (Build.VERSION.SDK_INT < 26) return
    val nm = getSystemService(NotificationManager::class.java)
    nm.createNotificationChannel(NotificationChannel(CH_SERVICE, "后台监听", NotificationManager.IMPORTANCE_MIN))
    nm.createNotificationChannel(NotificationChannel(CH_ALERTS, "会话提醒", NotificationManager.IMPORTANCE_HIGH))
  }

  private fun openAppIntent(): PendingIntent {
    val i = Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    return PendingIntent.getActivity(this, 0, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }

  private fun startForegroundCompat() {
    val n: Notification = NotificationCompat.Builder(this, CH_SERVICE)
      .setSmallIcon(R.drawable.ic_stat)
      .setContentTitle(if (authExpired) "登录已过期，请打开 AgentHub 重新登录" else "AgentHub 正在监听")
      .setPriority(NotificationCompat.PRIORITY_MIN)
      .setOngoing(true)
      .setContentIntent(openAppIntent())
      .build()
    if (Build.VERSION.SDK_INT >= 34) {
      startForeground(FG_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING)
    } else {
      startForeground(FG_ID, n)
    }
  }

  private fun wsUrl(): String? {
    val p = prefs(this)
    val url = p.getString("url", "")?.trim()?.trimEnd('/') ?: return null
    val token = p.getString("token", "") ?: ""
    if (url.isEmpty()) return null
    return url.replaceFirst("http", "ws") + "/ws?token=" + URLEncoder.encode(token.trim(), "UTF-8")
  }

  private fun connect() {
    if (stopped) return
    val url = wsUrl() ?: return
    ws?.cancel()
    val gen = ++generation
    val req = try {
      Request.Builder().url(url).build()
    } catch (e: Exception) {
      return
    }
    ws = client.newWebSocket(req, object : WebSocketListener() {
      override fun onOpen(webSocket: WebSocket, response: Response) {
        handler.post {
          if (gen != generation) return@post
          connected = true
          backoff = 1000L
        }
      }

      override fun onMessage(webSocket: WebSocket, text: String) {
        handler.post { if (gen == generation) handleMessage(text) }
      }

      override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
        if (code == 4401) handler.post { if (gen == generation) markAuthExpired() }
      }

      override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
        handler.post {
          if (gen != generation) return@post
          if (code == 4401) markAuthExpired() else dropAndRetry()
        }
      }

      override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
        handler.post {
          if (gen != generation) return@post
          if (response?.code == 401) markAuthExpired() else dropAndRetry()
        }
      }
    })
  }

  private val reconnect = Runnable { connect() }

  // 登录失效：不再重连，常驻通知提示去重新登录；下次 start()（重新登录后）才恢复
  private fun markAuthExpired() {
    if (authExpired) return
    authExpired = true
    connected = false
    ws?.cancel()
    ws = null
    handler.removeCallbacks(reconnect)
    if (!stopped) startForegroundCompat()
  }

  // 断开后 1s -> 60s 指数退避重连
  private fun dropAndRetry() {
    connected = false
    ws = null
    if (stopped || authExpired) return
    handler.removeCallbacks(reconnect)
    handler.postDelayed(reconnect, backoff)
    backoff = (backoff * 2).coerceAtMost(60_000L)
  }

  private fun registerNetwork() {
    if (netCallback != null) return
    val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    val cb = object : ConnectivityManager.NetworkCallback() {
      // 网络恢复时立即重连（已连上就不动）
      override fun onAvailable(network: Network) {
        handler.post {
          if (stopped || connected || authExpired) return@post
          handler.removeCallbacks(reconnect)
          backoff = 1000L
          connect()
        }
      }
    }
    try {
      cm.registerDefaultNetworkCallback(cb)
      netCallback = cb
    } catch (e: Exception) {
      // 没有网络状态权限等情况下退化为只靠退避重连
    }
  }

  private fun handleMessage(text: String) {
    val msg = try {
      JSONObject(text)
    } catch (e: Exception) {
      return
    }
    val type = msg.optString("type")
    if (type == "approval") {
      handleApproval(msg)
      return
    }
    if (type != "session") return
    val s = msg.optJSONObject("session") ?: return
    val id = s.optString("id")
    if (id.isEmpty()) return
    val nm = getSystemService(NotificationManager::class.java)
    // 同一会话用同一个通知 id 覆盖；已处理就取消
    if (s.optBoolean("acked", false)) {
      nm.cancel(id.hashCode())
      return
    }
    if (!msg.optBoolean("notify", false)) return
    val agent = when (s.optString("agent")) { "codex" -> "Codex"; "doubao" -> "豆包"; else -> "Claude" }
    val state = when (s.optString("state")) {
      "done" -> "已完成"
      "waiting" -> "等待授权"
      "aborted" -> "已中断"
      else -> return
    }
    val project = s.optString("project").ifEmpty { "会话" }
    val body = s.optString("summary").ifEmpty { s.optString("title") }.take(100)
    val n = NotificationCompat.Builder(this, CH_ALERTS)
      .setSmallIcon(R.drawable.ic_stat)
      .setContentTitle("$project · $agent $state")
      .setContentText(body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(body))
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setCategory(NotificationCompat.CATEGORY_MESSAGE)
      .setAutoCancel(true)
      .setContentIntent(openAppIntent())
      .build()
    nm.notify(id.hashCode(), n)
  }

  // 授权请求：新建 pending 时弹通知（点击打开 App 去批）；之后不再 pending（已处理 / 过期）就取消
  private fun handleApproval(msg: JSONObject) {
    val a = msg.optJSONObject("approval") ?: return
    val id = a.optString("id")
    if (id.isEmpty()) return
    val nm = getSystemService(NotificationManager::class.java)
    if (a.optString("status") != "pending") {
      nm.cancel(id.hashCode())
      return
    }
    if (!msg.optBoolean("notify", false)) return
    val project = a.optString("project").ifEmpty { "AgentHub" }
    val body = (a.optString("tool") + " " + a.optString("detail")).take(80)
    val n = NotificationCompat.Builder(this, CH_ALERTS)
      .setSmallIcon(R.drawable.ic_stat)
      .setContentTitle("$project · 请求授权")
      .setContentText(body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(body))
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setCategory(NotificationCompat.CATEGORY_MESSAGE)
      .setAutoCancel(true)
      .setContentIntent(openAppIntent())
      .build()
    nm.notify(id.hashCode(), n)
  }
}
