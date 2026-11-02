package com.wenbo.agenthub

import android.app.Activity
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import java.util.Locale

/** System TTS only; no audio upload or backend speech service. */
class ReplySpeech(private val activity: Activity) {
  @Volatile var status: String = "idle"
    private set
  private var engine: TextToSpeech? = null
  private var ready = false
  private var closed = false
  private var chunks: List<String> = emptyList()
  private var index = 0
  private var generation = 0
  private var language = Locale.SIMPLIFIED_CHINESE

  fun speak(text: String) {
    status = "speaking"
    activity.runOnUiThread {
      if (closed) { status = "error:语音服务已关闭"; return@runOnUiThread }
      generation++
      engine?.stop()
      language = if (text.any { it in '\u3400'..'\u9fff' }) Locale.SIMPLIFIED_CHINESE else Locale.US
      val parts = mutableListOf<String>()
      var offset = 0
      while (offset < text.length) {
        var end = minOf(offset + 1000, text.length)
        if (end < text.length && Character.isHighSurrogate(text[end - 1])) end--
        parts.add(text.substring(offset, end)); offset = end
      }
      chunks = parts; index = 0
      if (engine == null) {
        engine = TextToSpeech(activity.applicationContext) { result ->
          activity.runOnUiThread {
            if (closed) return@runOnUiThread
            ready = result == TextToSpeech.SUCCESS
            if (!ready) { status = "error:无法启动设备语音，请检查系统文字转语音设置"; chunks = emptyList(); engine?.shutdown(); engine = null }
            else if (chunks.isNotEmpty()) next()
          }
        }
        engine?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
          override fun onStart(id: String?) {}
          override fun onDone(id: String?) { activity.runOnUiThread { if (id == "$generation:$index") next() } }
          @Deprecated("Deprecated in Android")
          override fun onError(id: String?) { activity.runOnUiThread { if (id == "$generation:$index") { status = "error:朗读失败，请检查设备语音设置"; chunks = emptyList() } } }
        })
      } else if (ready) next()
    }
  }

  private fun next() {
    if (index >= chunks.size) { status = "idle"; return }
    val result = engine?.setLanguage(language)
    if (result == TextToSpeech.LANG_MISSING_DATA || result == TextToSpeech.LANG_NOT_SUPPORTED) {
      status = "error:设备尚未安装所需语言的语音包"; chunks = emptyList(); return
    }
    val text = chunks[index++]
    if (engine?.speak(text, TextToSpeech.QUEUE_FLUSH, null, "$generation:$index") == TextToSpeech.ERROR) {
      status = "error:设备语音服务无法朗读"; chunks = emptyList()
    }
  }

  fun stop() {
    status = "idle"
    activity.runOnUiThread { generation++; chunks = emptyList(); engine?.stop() }
  }
  fun close() {
    stop()
    activity.runOnUiThread { closed = true; engine?.shutdown(); engine = null }
  }
}
