import type { TaskConstraints } from "./api";

/**
 * 任务执行边界的常用策略。
 *
 * 策略只套「三个能力开关 + 一句话说明」，**不动 `paths`**：
 * 目录是每个任务各不相同的，套模板时替人改目录只会把边界改到错的地方。
 *
 * 顺序有意义：开关全 false 时排在前面的「常规改代码」优先于「只读分析」，
 * 所以下拉默认落在常规档，而不是一上来就说这任务是只读的。
 *
 * 这些值只影响「遇到这类动作要不要停下来问人」，不放宽硬红线：
 * 即便 push=true，`git push --force` 仍然会拦下来交给人。
 */
export type BoundPreset = {
  id: string;
  label: string;
  /** 一句话说明这一档到底放行了什么，直接显示在编辑器里 */
  hint: string;
  net: boolean;
  push: boolean;
  scripts: boolean;
  note: string;
};

export const BOUND_PRESETS = [
  {
    id: "code", label: "常规改代码",
    hint: "项目内读写 + 跑测试；不联网、不装依赖、不推远端。大部分任务用这个。",
    net: false, push: false, scripts: false,
    note: "只动项目内代码：不联网、不装依赖、不推远端",
  },
  {
    id: "deps", label: "要装依赖 / 调接口",
    hint: "额外放行联网与装依赖；推远端、自定义脚本仍然要你点。",
    net: true, push: false, scripts: false,
    note: "需要联网：装依赖或调外部接口，装完把锁文件一起提交",
  },
  {
    id: "release", label: "发版 / 推远端",
    hint: "放行推远端与自定义脚本；force push、改历史仍属硬红线，照样问你。",
    net: false, push: true, scripts: true,
    note: "改完跑构建并推远端；不 force push、不改写历史",
  },
  {
    id: "read", label: "只读分析",
    hint: "给排障和调研用。只读靠这句提示约束，真动手改文件时仍会停下来问你。",
    net: false, push: false, scripts: false,
    note: "只读分析：不改文件、不装依赖，结论写进最后回复",
  },
] as const satisfies readonly BoundPreset[];

export type PresetId = (typeof BOUND_PRESETS)[number]["id"] | "custom";

export const PRESET_NOTE = new Set<string>(BOUND_PRESETS.map(p => p.note));

/** 说明是人自己写的（不是模板里那句）——套模板时不覆盖它 */
export const hasCustomNote = (c: TaskConstraints): boolean => !!c.note && !PRESET_NOTE.has(c.note);

const sameFlags = (c: TaskConstraints, p: BoundPreset): boolean =>
  c.net === p.net && c.push === p.push && c.scripts === p.scripts;

/** 从现有边界反推套的是哪一档：说明被改过就算自定义，别假装还是模板 */
export function presetOf(c: TaskConstraints): PresetId {
  const exact = BOUND_PRESETS.find(p => sameFlags(c, p) && p.note === c.note);
  if (exact) return exact.id;
  if (c.note) return "custom";
  return BOUND_PRESETS.find(p => sameFlags(c, p))?.id ?? "custom";
}

/** 套用一档：开关和说明跟着换；人自己写的说明保留，别替人删字 */
export function applyPreset(c: TaskConstraints, id: PresetId): TaskConstraints {
  if (id === "custom") return c;
  const p = BOUND_PRESETS.find(x => x.id === id);
  if (!p) return c;
  return { ...c, net: p.net, push: p.push, scripts: p.scripts, note: hasCustomNote(c) ? c.note : p.note };
}

/** 下拉里那行提示：自定义档要说清「为什么不是模板」，否则看着像没生效 */
export function presetHint(c: TaskConstraints): string {
  const id = presetOf(c);
  if (id === "custom") {
    return hasCustomNote(c)
      ? "说明是你自己写的：换场景只改下面三个开关，不会覆盖这句话。"
      : "自己勾下面三项：不勾的动作为了保险起见，执行到时会停下来问你。";
  }
  const hint = BOUND_PRESETS.find(p => p.id === id)!.hint;
  // 说明空着 = boundaryLine 是空串，这套边界压根不会拼进系统提示
  return c.note ? hint : `${hint}说明空着，边界不会拼进系统提示。`;
}
