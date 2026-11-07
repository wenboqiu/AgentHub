import { useCallback, useEffect, useState } from "react";
import {
  CAN_LIST_MODELS,
  loadAgentModels,
  modelHints,
  type ModelList,
  type ModelOption,
} from "./lib/models";
import { isDesktop } from "./lib/platform";

const CUSTOM = "__custom__";

/** 选项文案：`GLM-5.3 · 1M 上下文 · x0.69`，id 与名字不同时把 id 也带上 */
function optionText(o: ModelOption): string {
  const name = o.label && o.label !== o.id ? `${o.label} · ${o.id}` : o.id;
  return o.note ? `${name} · ${o.note}` : name;
}

/**
 * 模型下拉：能读到清单的执行端（CodeBuddy / ZCode）自动列出来，读不到就退回手填。
 * - 「默认（留空）」= 交给执行端自己决定，换版本也不用回来改；
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
  const listable = isDesktop && CAN_LIST_MODELS.has(agent);
  const [list, setList] = useState<ModelList | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [custom, setCustom] = useState(false);

  const load = useCallback(
    async (refresh: boolean) => {
      if (!listable) {
        setList(null);
        return;
      }
      setLoading(true);
      setError("");
      try {
        setList(await loadAgentModels(agent, refresh));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [agent, listable],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  const options: ModelOption[] = list?.models.length
    ? list.models
    : hints.map(h => ({ id: h, label: h }));
  const known = options.some(o => o.id === value);

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
    <span className="model-row">
      <select
        value={value}
        disabled={disabled}
        title={list?.detail}
        onChange={e => {
          if (e.target.value === CUSTOM) { setCustom(true); return; }
          onChange(e.target.value);
        }}>
        <option value="">默认（留空 = 执行端自己决定）</option>
        {options.map(o => (
          <option key={o.id} value={o.id} title={o.hint}>
            {optionText(o)}
          </option>
        ))}
        {value && !known && <option value={value}>{value}（当前值）</option>}
        <option value={CUSTOM}>其他（手动填完整 id）…</option>
      </select>
      {listable && (
        <button
          type="button"
          className="ghost model-refresh"
          disabled={disabled || loading}
          title={error || list?.detail || "重新读取模型清单"}
          onClick={() => void load(true)}>
          {loading ? "读取中…" : error ? "重试" : "刷新"}
        </button>
      )}
      {error && <span className="model-error">清单读取失败</span>}
    </span>
  );
}
