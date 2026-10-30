package com.wenbo.agenthub

import android.Manifest
import android.app.Activity
import android.content.Context
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
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  // 给前端注入 window.AgentHubNative
  override fun onWebViewCreate(webView: WebView) {
    webView.addJavascriptInterface(NativeBridge(this), "AgentHubNative")
  }
}

/** 前端调用的原生桥：开关前台服务、查通知权限、跳电池优化设置 */
class NativeBridge(private val activity: Activity) {
  private val ctx: Context = activity.applicationContext

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
