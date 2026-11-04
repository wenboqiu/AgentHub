package com.wenbo.agenthub

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject

class MainActivity : TauriActivity() {
  private var bridge: NativeBridge? = null
  private var web: WebView? = null
  /** 正在等结果的选图请求（同一时刻只允许开一个相册界面） */
  private var pickRequest: Pair<String, Int>? = null

  /** 系统相册：Android 13+ 走 Photo Picker，老系统由 androidx 回落到文件选择器，都不需要存储权限 */
  private val picker: ActivityResultLauncher<PickVisualMediaRequest> =
    registerForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(MAX_PICK)) { uris ->
      deliver(uris)
    }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  // 给前端注入 window.AgentHubNative
  override fun onWebViewCreate(webView: WebView) {
    bridge?.close()
    web = webView
    bridge = NativeBridge(this)
    webView.addJavascriptInterface(bridge!!, "AgentHubNative")
  }
  override fun onDestroy() {
    bridge?.close()
    web = null
    pickRequest = null
    super.onDestroy()
  }

  /** 前端点了图片按钮：开相册，结果逐张回给 window.__agenthubPickImage */
  fun startImagePick(requestId: String, limit: Int) {
    // 从 JS 桥的线程切到主线程，pickRequest 只在主线程读写
    runOnUiThread {
      if (pickRequest != null) return@runOnUiThread
      pickRequest = requestId to limit.coerceIn(1, MAX_PICK)
      runCatching {
        picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
      }.onFailure {
        pickRequest = null
        finishPick(requestId, "这台设备打不开相册")
      }
    }
  }

  private fun deliver(uris: List<Uri>) {
    val (id, limit) = pickRequest ?: return
    pickRequest = null
    val take = uris.take(limit)
    val dropped = uris.size - take.size
    if (take.isEmpty()) {
      finishPick(id, "")
      return
    }
    // 解码 + 压缩比较重，放后台线程，避免卡住输入框
    Thread {
      var failed = 0
      for (uri in take) {
        val url = runCatching { ImagePick.toDataUrl(contentResolver, uri) }.getOrNull()
        if (url == null) failed++ else runOnUiThread { emitPick(id, url) }
      }
      val skipped = dropped + failed
      runOnUiThread { finishPick(id, if (skipped > 0) "有 $skipped 张图片读不出来或太大，已跳过" else "") }
    }.start()
  }

  private fun emitPick(id: String, dataUrl: String) {
    val js = "window.__agenthubPickImage && window.__agenthubPickImage(${JSONObject.quote(id)}, ${JSONObject.quote(dataUrl)})"
    web?.evaluateJavascript(js, null)
  }

  private fun finishPick(id: String, message: String) {
    val js = "window.__agenthubPickDone && window.__agenthubPickDone(${JSONObject.quote(id)}, ${JSONObject.quote(message)})"
    web?.evaluateJavascript(js, null)
  }

  private companion object {
    /** 和前端的 MAX_IMAGES 对齐：一次最多能收 4 张 */
    const val MAX_PICK = 4
  }
}

/** 前端调用的原生桥：开关前台服务、查通知权限、跳电池优化设置 */
class NativeBridge(private val activity: Activity) {
  private val ctx: Context = activity.applicationContext
  private val voice = ReplySpeech(activity)
  fun close() { voice.close() }

  /** 相册选图：压好的 data URL 通过 window.__agenthubPickImage 逐张回传 */
  @JavascriptInterface
  fun pickImages(requestId: String, limit: Int) {
    (activity as? MainActivity)?.startImagePick(requestId, limit)
  }

  @JavascriptInterface
  fun copyText(text: String) {
    activity.runOnUiThread { (ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("AgentHub 回复", text)) }
  }
  @JavascriptInterface
  fun speak(text: String) { voice.speak(text) }
  @JavascriptInterface
  fun stopSpeech() { voice.stop() }
  @JavascriptInterface
  fun speechStatus(): String = voice.status

  @JavascriptInterface
  fun start(url: String, token: String) {
    AgentHubService.prefs(ctx).edit().putString("url", url).putString("token", token).putBoolean("enabled", true).apply()
    // Android 13+ 没通知权限时先请求（异步；服务照常启动，授权后新的提醒就能弹出）
    if (Build.VERSION.SDK_INT >= 33 &&
      ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
    ) {
      activity.runOnUiThread {
        ActivityCompat.requestPermissions(activity, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1001)
      }
    }
    // 配置变了就重启，让服务用新地址重连
    ctx.stopService(Intent(ctx, AgentHubService::class.java))
    ContextCompat.startForegroundService(ctx, Intent(ctx, AgentHubService::class.java))
  }

  @JavascriptInterface
  fun stop() {
    AgentHubService.prefs(ctx).edit().putBoolean("enabled", false).apply()
    ctx.stopService(Intent(ctx, AgentHubService::class.java))
  }

  @JavascriptInterface
  fun isRunning(): Boolean = AgentHubService.prefs(ctx).getBoolean("enabled", false) && AgentHubService.running

  @JavascriptInterface
  fun notificationsEnabled(): Boolean = NotificationManagerCompat.from(ctx).areNotificationsEnabled()

  @JavascriptInterface
  fun openBatterySettings() {
    val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
    val intent = if (!pm.isIgnoringBatteryOptimizations(ctx.packageName)) {
      Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${ctx.packageName}"))
    } else {
      Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
    }
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    try {
      ctx.startActivity(intent)
    } catch (e: Exception) {
      ctx.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
  }
}
