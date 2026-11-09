import { useEffect, useState, type KeyboardEvent } from "react";
import type { TaskConstraints } from "./lib/api";
import { BOUND_PRESETS, applyPreset, presetHint, presetOf, type PresetId } from "./lib/boundsPresets";

/** 四项能力开关：勾上 = 这个任务授权了这类动作，不勾 = 遇到就停下来问人 */
const BOUND_FLAGS = [
  { key: "net", label: "可联网 / 装依赖", hint: "装新依赖、调外部接口" },
  { key: "push", label: "可推远端", hint: "git push" },
  { key: "scripts", label: "可跑脚本", hint: "npm run xxx、sh / node / python" },
] as const;

/**
 * 执行边界编辑器：文本类字段失焦才提交，勾选立刻生效。
 * 这里声明的不是「权限」而是「这个任务预计要动到哪」，所以默认全空——
 * 没声明的能力一律按「遇到就问人」处理，宁可多问一句。
 */
export default function BoundsEditor({ value, disabled, onChange }: { value: TaskConstraints; disabled: boolean; onChange(v: TaskConstraints): void }) {
  const joined = value.paths.join(", ");
  const [paths, setPaths] = useState(joined);
  const [note, setNote] = useState(value.note);
  // 别处改过（项目经理细化、别的设备编辑）就跟着同步，别让人看着旧值
  useEffect(() => { setPaths(joined); }, [joined]);
  useEffect(() => { setNote(value.note); }, [value.note]);
  const commitPaths = () => {
    const next = paths.split(/[,，;；\s]+/).map(s => s.trim()).filter(Boolean);
    if (next.join("|") === value.paths.join("|")) return;
    onChange({ ...value, paths: next });
  };
  const commitNote = () => {
    const next = note.trim();
    if (next === value.note) return;
    onChange({ ...value, note: next });
  };
  const onEnter = (e: KeyboardEvent<HTMLInputElement>) => { if (e.key === "Enter") e.currentTarget.blur(); };

  const preset = presetOf(value);
  const apply = (id: PresetId) => {
    // 「自定义」只是状态，不是动作：选了什么都不改
    if (id === "custom") return;
    const next = applyPreset(value, id);
    if (next.net === value.net && next.push === value.push && next.scripts === value.scripts && next.note === value.note) return;
    onChange(next);
  };
  const hint = presetHint(value);

  return (
    <div className="bounds-editor">
      <label className="bounds-preset">场景
        <select className="inline-control" aria-label="边界策略" value={preset} disabled={disabled}
          onChange={e => apply(e.target.value as PresetId)}>
          {BOUND_PRESETS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
          <option value="custom">自定义</option>
        </select>
      </label>
      <p className="bounds-hint dim">{hint}
        {/* 下拉选中项再点一次不会触发 change，说明空着时给一个明确的「填上」入口 */}
        {preset !== "custom" && !value.note && (
          <button type="button" className="link" disabled={disabled} onClick={() => apply(preset)}>填上</button>
        )}
      </p>
      <label className="bounds-paths">只允许改
        <input className="inline-control" value={paths} maxLength={400} disabled={disabled}
          placeholder="留空 = 整个项目目录；多个用逗号分隔，如 server/src, docs"
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
      <input className="inline-control" value={note} maxLength={400} disabled={disabled}
        placeholder="补充一句（会拼进执行者的系统提示），如：只动服务端，前端这次不碰"
        onChange={e => setNote(e.target.value)} onBlur={commitNote} onKeyDown={onEnter} />
    </div>
  );
}
