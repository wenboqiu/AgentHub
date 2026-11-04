/** 用户附图：读文件 → 压缩 → data URL。上限与服务端 routes.ts 的 cleanUserImages 保持一致 */

export const MAX_IMAGES = 4
/** 单张 data URL 的字符上限（服务端也是这个数） */
export const MAX_IMAGE_CHARS = 2_500_000
export const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/** 长边超过这个就缩小：手机原图动辄 4000px，压到 1600 看清截图足够了 */
const MAX_EDGE = 1600
const QUALITY = 0.85

/** 从一批文件里挑能用的，返回要处理的文件和一句提示（超量/格式不对都从这里说） */
export function pickImageFiles(files: File[], existing: number): { files: File[]; error: string } {
  const room = MAX_IMAGES - existing
  if (room <= 0) return { files: [], error: `最多附 ${MAX_IMAGES} 张图片` };
  const images = files.filter((f) => ACCEPTED_TYPES.includes(f.type))
  if (!images.length) return { files: [], error: "只支持 png / jpeg / webp / gif 图片" };
  if (images.length > room) return { files: images.slice(0, room), error: `最多附 ${MAX_IMAGES} 张图片，多出的没有加进来` };
  return { files: images, error: "" };
}

/** 这个 data URL 还能不能收（超限就别塞进输入框了） */
export const fitsLimit = (dataUrl: string): boolean => dataUrl.length <= MAX_IMAGE_CHARS

/**
 * 读一张图片并压成 data URL。
 * gif 不压（canvas 会丢掉动画），其余按长边缩放后编码；png 保留透明，其他统一转 jpeg。
 */
export async function fileToDataUrl(file: File): Promise<string> {
  const raw = await readAsDataUrl(file)
  if (file.type === "image/gif") return raw
  const bitmap = await createImageBitmap(file).catch(() => null)
  if (!bitmap) return raw // 环境不支持解码（比如某些 WebView）就用原图
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
  const w = Math.max(1, Math.round(bitmap.width * scale))
  const h = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement("canvas")
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext("2d")
  if (!ctx) return raw
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close?.()
  const keepAlpha = file.type === "image/png" && hasAlpha(ctx, w, h)
  const out = keepAlpha ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", QUALITY)
  // 压完反而更大（小图转 jpeg 会更小，但 png 截图偶尔变大）：取小的那个
  return out.length < raw.length ? out : raw
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error("读取图片失败"))
    reader.readAsDataURL(file)
  })
}

/** 抽样看有没有半透明像素，决定 png 要不要保留 */
function hasAlpha(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
  try {
    const { data } = ctx.getImageData(0, 0, w, h)
    for (let i = 3; i < data.length; i += 4 * 16) if (data[i] < 255) return true
  } catch {
    return true // 读不到像素（跨域/污染）就保守保留 png
  }
  return false
}
