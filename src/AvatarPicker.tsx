import { useRef, type ReactNode } from "react";
import type { AgentAvatarSpec } from "./lib/api";
import { AVATAR_PRESETS, INITIAL_PRESET, MASCOT_PRESETS, imageToAvatar } from "./lib/avatars";

/**
 * 头像选择器：默认 / 网上形象 / 首字母与 emoji / 上传图片。agent、角色、项目三处共用。
 * value = null 表示用默认头像（由 preview(null) 画出来是什么）；点哪个就 onPick 哪个，存不存由调用方决定。
 */
export default function AvatarPicker({ value, busy = false, preview, defaultTitle, hideMascot, hideInitial = false, onPick, onError }: {
  value: AgentAvatarSpec | null;
  busy?: boolean;
  /** 按某个 spec 画一个预览头像（null = 默认） */
  preview(spec: AgentAvatarSpec | null): ReactNode;
  /** 「默认」那格的说明，例如「默认：Clawd」 */
  defaultTitle: string;
  /** 默认头像本身就是某个网上形象时，列表里不再重复它 */
  hideMascot?: string;
  /** 默认头像本身就是首字母时（项目），不再单列「首字母」 */
  hideInitial?: boolean;
  onPick(spec: AgentAvatarSpec | null): void;
  onError(msg: string): void;
}) {
  const file = useRef<HTMLInputElement>(null);
  const isPreset = (id: string) => value?.kind === "preset" && value.id === id;
  const cell = (key: string, on: boolean, title: string, spec: AgentAvatarSpec | null, tag?: string) => (
    <button key={key} type="button" role="radio" aria-checked={on} aria-label={title} title={title} className={on ? "on" : ""} disabled={busy} onClick={() => onPick(spec)}>
      {preview(spec)}
      {tag && <span className="avatar-tag">{tag}</span>}
    </button>
  );
  const upload = async (f: File | undefined) => {
    if (!f) return;
    try {
      onPick({ kind: "image", data: await imageToAvatar(f) });
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      if (file.current) file.current.value = "";
    }
  };

  return (
    <div className="avatar-picker">
      <p className="hint">网上的形象</p>
      <div className="avatar-presets" role="radiogroup" aria-label="网上的形象">
        {cell("default", !value, defaultTitle, null, "默认")}
        {MASCOT_PRESETS.filter((p) => p.id !== hideMascot).map((p) => cell(p.id, isPreset(p.id), p.label, { kind: "preset", id: p.id }))}
        {value?.kind === "image" && cell("image", true, "自定义图片", value)}
      </div>
      <p className="hint">{hideInitial ? "emoji" : "首字母与 emoji"}</p>
      <div className="avatar-presets" role="radiogroup" aria-label={hideInitial ? "emoji" : "首字母与 emoji"}>
        {!hideInitial && cell(INITIAL_PRESET, isPreset(INITIAL_PRESET), "首字母", { kind: "preset", id: INITIAL_PRESET })}
        {AVATAR_PRESETS.map((p) => cell(p.id, isPreset(p.id), p.emoji, { kind: "preset", id: p.id }))}
      </div>
      <div className="btns">
        <button type="button" disabled={busy} onClick={() => file.current?.click()}>上传图片…</button>
        {value && <button type="button" disabled={busy} onClick={() => onPick(null)}>恢复默认</button>}
      </div>
      <input ref={file} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(e) => void upload(e.target.files?.[0])} />
      <p className="hint">图片会居中裁成正方形、缩到 96×96 再保存。</p>
    </div>
  );
}
