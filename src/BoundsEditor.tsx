import { useEffect, useState, type KeyboardEvent } from "react";
import type { TaskConstraints } from "./lib/api";

/** 三项能力开关：勾上 = 这个任务授权了这类动作，不勾 = 遇到就停下来问人 */
const BOUND_FLAGS = [
  { key: "net", on: "可联网", off: "不联网", label: "可联网 / 装依赖", hint: "装新依赖、调外部接口" },
  { key: "push", on: "可推远端", off: "不推远端", label: "可推远端", hint: "git push" },
  { key: "scripts", on: "可跑脚本", off: "不跑自定义脚本", label: "可跑脚本", hint: "npm run xxx、sh / node / python" },
] as const;

/** 一行摘要：每项都说出来（包括「不」），一眼看清这个任务被允许做什么 */
export const boundSummary = (c: TaskConstraints): string[] => [
  c.paths.length ? `只改 ${c.paths.join("、")}` : "整个项目",
  ...BOUND_FLAGS.map(f => (c[f.key] ? f.on : f.off)),
];

/**
 * 执行边界：平时只露一行摘要，点「修改」才展开目录与三个开关。
 * 大多数任务不用动它——项目经理生成任务单时已经按需要写好，空着也能正常改代码、跑测试；
 * 只有事先知道要联网、推远端、跑脚本，或想把改动圈在某几个目录里时才需要改。
 * 那句说明（note）由项目经理写，随系统提示下发；这里只展示不编辑。
 */
export default function BoundsEditor({ value, disabled, frozen = false, onChange }: {
  value: TaskConstraints;
  disabled: boolean;
  /** 已签署冻结：只展示，不给改 */
  frozen?: boolean;
  onChange(v: TaskConstraints): void;
}) {
  const [open, setOpen] = useState(false);
  const joined = value.paths.join(", ");
  const [paths, setPaths] = useState(joined);
  // 别处改过（项目经理细化、别的设备编辑）就跟着同步，别让人看着旧值
  useEffect(() => { setPaths(joined); }, [joined]);
  const commitPaths = () => {
    const next = paths.split(/[,，;；\s]+/).map(s => s.trim()).filter(Boolean);
    if (next.join("|") === value.paths.join("|")) return;
    onChange({ ...value, paths: next });
  };
  const onEnter = (e: KeyboardEvent<HTMLInputElement>) => { if (e.key === "Enter") e.currentTarget.blur(); };

  return (
    <div className="bounds-editor">
      <div className="bound-chips">
        {boundSummary(value).map(c => <span key={c} className="bound-chip">{c}</span>)}
        {frozen
          ? <span className="dim">· 已冻结</span>
          : <button type="button" className="link" aria-expanded={open} disabled={disabled} onClick={() => setOpen(v => !v)}>{open ? "收起" : "修改"}</button>}
      </div>
      {value.note && <p className="bounds-hint dim">{value.note}</p>}
      {open && !frozen && (
        <>
          <label className="bounds-paths">只允许改
            <input className="inline-control" value={paths} maxLength={400} disabled={disabled}
              placeholder="留空 = 整个项目，如 server/src, docs"
              onChange={e => setPaths(e.target.value)} onBlur={commitPaths} onKeyDown={onEnter} />
          </label>
          <div className="bounds-flags">
            {BOUND_FLAGS.map(f => (
              <label key={f.key} className="check" title={f.hint}>
                <input type="checkbox" checked={value[f.key]} disabled={disabled}
                  onChange={() => onChange({ ...value, [f.key]: !value[f.key] })} />{f.label}
              </label>
            ))}
          </div>
          <p className="bounds-hint dim">不勾的那类动作执行中会停下来问你；项目内改代码、跑测试和构建不受影响。删库、强推这类硬红线勾了也照样问。</p>
        </>
      )}
    </div>
  );
}
