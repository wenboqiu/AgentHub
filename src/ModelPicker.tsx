import { useCallback, useEffect, useState } from "react";
import { autoModelRange, modelHints } from "./lib/models";
import {
  CAN_LIST_MODELS,
  loadAgentModels,
  type ModelList,
  type ModelOption,
} from "./lib/agent-models";
import { isDesktop } from "./lib/platform";
import { effortOptions, joinModel, splitModelEffort } from "./lib/efforts";

const CUSTOM = "__custom__";

/** 选项文案：`GLM-5.3 · 1M 上下文 · x0.69`，id 与名字不同时把 id 也带上 */
function optionText(o: ModelOption): string {
  const name = o.label && o.label !== o.id ? `${o.label} · ${o.id}` : o.id;
  return o.note ? `${name} · ${o.note}` : name;
}

/**
 * 模型下拉：能读到清单的执行端（CodeBuddy / ZCode）自动列出来，其余用常用 id；
 * 读不到就只剩「默认」和手填。
 * - 「默认（留空）」= 不指定模型：项目经理能代挑的工具（Claude / Codex）派活时
 *   按任务复杂度挑一档，其它工具就是执行端自己的默认；
 * - 清单外的值（历史数据、助手给的）仍会作为一项出现，不会被吞掉；
 * - 「其他…」留给清单还没收录的模型，手填完整 id。
 * 换执行工具时父组件会重置模型，记得给本组件加 key={agent} 让自定义态一并复位。
 */
export default function ModelPicker({
  agent,
  value: raw,
  disabled,
  onChange,
}: {
  agent: string;
  value: string;
  disabled?: boolean;
  onChange(model: string): void;
}) {
  // model 字符串里带着思考强度：`<模型id>@<强度>`，这里拆开分别编辑，保存时拼回
  const { model: value, effort } = splitModelEffort(raw);
  const efforts = effortOptions(agent, value);
  const setModel = (m: string) => {
    const keep = effort && effortOptions(agent, m).some(o => o.value === effort) ? effort : "";
    onChange(joinModel(m, keep));
  };
  const effortSelect = (efforts.length > 0 || !!effort) && (
    <select
      className="effort-select"
      value={effort}
      disabled={disabled}
      title="思考强度"
      aria-label="思考强度"
      onChange={e => onChange(joinModel(value, e.target.value))}>
      <option value="">思考强度：默认</option>
      {efforts.map(o => (
        <option key={o.value} value={o.value}>思考强度：{o.label}</option>
      ))}
      {effort && !efforts.some(o => o.value === effort) && <option value={effort}>思考强度：{effort}（当前值）</option>}
    </select>
  );
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
          onChange={e => setModel(e.target.value)}
        />
        <button type="button" className="ghost" disabled={disabled} onClick={() => { setCustom(false); setModel(""); }}>
          选回列表
        </button>
        {effortSelect}
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
          setModel(e.target.value);
        }}>
        <option value="">
          {autoModelRange(agent).length ? "默认（留空 = 派活时由项目经理挑）" : "默认（留空 = 执行端自己决定）"}
        </option>
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
      {effortSelect}
      {error && <span className="model-error">清单读取失败</span>}
    </span>
  );
}
