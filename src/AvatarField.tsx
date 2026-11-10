import { useState, type ReactNode } from "react";
import type { AgentAvatarSpec } from "./lib/api";
import AvatarPicker from "./AvatarPicker";

/** 编辑页里的头像一栏：平时只露当前头像，点「更换头像」才展开选择器；改动随表单一起保存 */
export default function AvatarField({ value, busy, preview, defaultTitle, hideInitial, onChange }: {
  value: AgentAvatarSpec | null;
  busy: boolean;
  preview(spec: AgentAvatarSpec | null, size: number): ReactNode;
  defaultTitle: string;
  hideInitial?: boolean;
  onChange(spec: AgentAvatarSpec | null): void;
}) {
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState("");
  return (
    <div className="avatar-field">
      <div className="avatar-field-head">
        {preview(value, 56)}
        <div>
          <strong>头像</strong>
          <p className="dim">{value ? "自定义" : defaultTitle}</p>
        </div>
        <button type="button" className="ghost" aria-expanded={open} disabled={busy} onClick={() => setOpen((v) => !v)}>
          {open ? "收起" : "更换头像"}
        </button>
      </div>
      {open && (
        <AvatarPicker value={value} busy={busy} preview={(s) => preview(s, 40)} defaultTitle={defaultTitle} hideInitial={hideInitial}
          onPick={(s) => { setErr(""); onChange(s); }} onError={setErr} />
      )}
      {err && <p className="form-error" role="alert">{err}</p>}
    </div>
  );
}
