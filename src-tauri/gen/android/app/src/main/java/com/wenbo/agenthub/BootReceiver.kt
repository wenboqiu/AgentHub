package com.wenbo.agenthub

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat

/** 开机后，如果用户开着后台提醒就重新启动前台服务 */
class BootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
    if (!AgentHubService.prefs(context).getBoolean("enabled", false)) return
    try {
      ContextCompat.startForegroundService(context, Intent(context, AgentHubService::class.java))
    } catch (e: Exception) {
      // 系统不允许开机时启动前台服务就放弃，用户打开 App 时可再开启
    }
  }
}
