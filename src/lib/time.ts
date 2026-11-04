const pad = (n: number) => String(n).padStart(2, "0");

/**
 * 消息时间标签：今天的只显示时分，昨天加「昨天」，今年内补月日，跨年补年份。
 * 完整时间放 title 悬停看，避免列表里出现一长串日期。
 */
export function clockAt(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  // 用日历日相减而不是减 86400000，夏令时切换当天也算得准
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = d.getTime();
  if (t >= startOfToday) return hm;
  const startOfYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
  if (t >= startOfYesterday) return `昨天 ${hm}`;
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return d.getFullYear() === now.getFullYear() ? `${md} ${hm}` : `${d.getFullYear()}-${md} ${hm}`;
}

/** 悬停提示用的完整时间（跟随系统时区与语言） */
export function fullAt(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}
