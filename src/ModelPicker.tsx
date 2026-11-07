import { useState } from "react";
import { modelHints } from "./lib/models";

const CUSTOM = "__custom__";

/**
 * 模型下拉：常用 id 直接选，不再靠 datalist 猜。
 * - 「默认（留空）」= 不指定：派活时由项目经理按任务复杂度在同工具里挑一档，
 *   工具没有可挑清单时才是执行端自己的默认模型；
 * - 清单外的值（历史数据、助手给的）仍会作为一项出现，不会被吞掉；
 * - 「其他…」留给清单还没收录的模型，手填完整 id。
 * 换执行工具时父组件会重置模型，记得给本组件加 key={agent} 让自定义态一并复位。
 */
export default function ModelPicker({
  agent,
  value,
  disabled,
  onChange,
}: {
  agent: string;
  value: string;
  disabled?: boolean;
  onChange(model: string): void;
}) {
  const hints = modelHints(agent);
  const [custom, setCustom] = useState(false);

  if (custom) {
    return (
      <span className="model-custom">
        <input
          value={value}
          maxLength={120}
          disabled={disabled}
          autoFocus
          placeholder="模型 id，例如 opus / gpt-6.1-sol"
          onChange={e => onChange(e.target.value)}
        />
        <button type="button" className="ghost" disabled={disabled} onClick={() => { setCustom(false); onChange(""); }}>
          选回列表
        </button>
      </span>
    );
  }

  return (
    <select value={value} disabled={disabled}
      onChange={e => {
        if (e.target.value === CUSTOM) { setCustom(true); return; }
        onChange(e.target.value);
      }}>
      <option value="">默认（留空 = 派活时由项目经理挑）</option>
      {hints.map(m => <option key={m} value={m}>{m}</option>)}
      {value && !hints.includes(value) && <option value={value}>{value}（当前值）</option>}
      <option value={CUSTOM}>其他（手动填完整 id）…</option>
    </select>
  );
}
