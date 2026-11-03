import { useEffect, useRef, useState } from "react";

type Props = {
  value: string;
  onSave(value: string): void;
  ariaLabel: string;
  placeholder?: string;
  maxLength?: number;
  /** 多行文本用 textarea（备注等） */
  multiline?: boolean;
  className?: string;
  /** 空值是否回滚到原值（标题、清单项必须非空；备注可为空） */
  required?: boolean;
  disabled?: boolean;
};

/**
 * 就地编辑：字段本身就是输入框，点进去改，失焦或回车即保存，Esc 撤销。
 * 参考 Linear / Todoist 的详情页做法——没有「编辑 / 保存 / 取消」模式，
 * 避免一改一个字段就要进出编辑态。
 */
export default function InlineField({ value, onSave, ariaLabel, placeholder, maxLength = 200, multiline = false, className = "", required = true, disabled = false }: Props) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  useEffect(() => { setDraft(value); }, [value]);

  const commit = () => {
    const next = draft.trim();
    if (next === value.trim()) return;
    if (!next && required) { setDraft(value); return; }
    onSave(next);
  };
  const cancel = () => { setDraft(value); };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); cancel(); (e.target as HTMLElement).blur(); }
    // 单行：回车提交；多行：⌘/Ctrl + 回车提交，保留换行
    else if (e.key === "Enter" && (!multiline || e.metaKey || e.ctrlKey)) { e.preventDefault(); (e.target as HTMLElement).blur(); }
  };

  const shared = {
    value: draft, "aria-label": ariaLabel, placeholder, maxLength, disabled,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
    onBlur: commit, onKeyDown, className: `inline-field ${className}`.trim(),
  };
  return multiline
    ? <textarea {...shared} rows={Math.min(10, Math.max(2, Math.ceil((draft.length + 1) / 56)))} ref={el => { ref.current = el; }} />
    : <input {...shared} ref={el => { ref.current = el; }} />;
}
