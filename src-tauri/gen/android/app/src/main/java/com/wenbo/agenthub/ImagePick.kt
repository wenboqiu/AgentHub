package com.wenbo.agenthub

import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.util.Base64
import java.io.ByteArrayOutputStream

/**
 * 相册选图后的解码。手机拍的照片基本是 HEIC、而且方向只写在 EXIF 里，
 * 这些都是 WebView 的 canvas 处理不了的，所以在原生侧一次性做完再回给前端。
 */
object ImagePick {
  /** 长边上限，和前端 images.ts 的 MAX_EDGE 保持一致 */
  private const val MAX_EDGE = 1600
  private const val JPEG_QUALITY = 85
  /** 压缩后字节上限：base64 大约 1.33 倍，得留在 data URL 2.5M 字符以内 */
  private const val MAX_BYTES = 1_800_000

  /** 把相册给的一张图变成能直接发出去的 data URL；读不了或太大返回 null */
  fun toDataUrl(resolver: ContentResolver, uri: Uri): String? {
    val mime = resolver.getType(uri) ?: "image/jpeg"
    // gif 不重编码（会丢动画），原样转 base64
    if (mime == "image/gif") {
      val raw = resolver.openInputStream(uri)?.use { it.readBytes() } ?: return null
      if (raw.size > MAX_BYTES) return null
      return "data:image/gif;base64," + Base64.encodeToString(raw, Base64.NO_WRAP)
    }

    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) } ?: return null
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null

    val opts = BitmapFactory.Options().apply { inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight) }
    val decoded = resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, opts) } ?: return null
    val orientation = readOrientation(resolver, uri)
    val bitmap = fit(decoded, orientation)
    if (bitmap !== decoded) decoded.recycle()

    val out = ByteArrayOutputStream()
    bitmap.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out)
    bitmap.recycle()
    val bytes = out.toByteArray()
    if (bytes.size > MAX_BYTES) return null
    return "data:image/jpeg;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)
  }

  /** 只用 2 的幂降采样，剩下的零头交给 fit() 精确缩放 */
  private fun sampleSize(w: Int, h: Int): Int {
    var sample = 1
    while (maxOf(w, h) / sample > MAX_EDGE) sample *= 2
    return sample
  }

  private fun readOrientation(resolver: ContentResolver, uri: Uri): Int =
    resolver.openInputStream(uri)?.use {
      runCatching {
        ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
      }.getOrDefault(ExifInterface.ORIENTATION_NORMAL)
    } ?: ExifInterface.ORIENTATION_NORMAL

  /** 按 EXIF 摆正 + 缩到长边 MAX_EDGE，返回的 bitmap 可能不是传进来的那张 */
  private fun fit(src: Bitmap, orientation: Int): Bitmap {
    val m = Matrix()
    when (orientation) {
      ExifInterface.ORIENTATION_ROTATE_90 -> m.postRotate(90f)
      ExifInterface.ORIENTATION_ROTATE_180 -> m.postRotate(180f)
      ExifInterface.ORIENTATION_ROTATE_270 -> m.postRotate(270f)
      ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> m.postScale(-1f, 1f)
      ExifInterface.ORIENTATION_FLIP_VERTICAL -> m.postScale(1f, -1f)
      ExifInterface.ORIENTATION_TRANSPOSE -> { m.postRotate(90f); m.postScale(-1f, 1f) }
      ExifInterface.ORIENTATION_TRANSVERSE -> { m.postRotate(270f); m.postScale(-1f, 1f) }
    }
    val scale = MAX_EDGE.toFloat() / maxOf(src.width, src.height)
    if (scale < 1f) m.postScale(scale, scale)
    if (m.isIdentity) return src
    return Bitmap.createBitmap(src, 0, 0, src.width, src.height, m, true)
  }
}
