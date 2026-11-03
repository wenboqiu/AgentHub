import { useEffect, useState } from "react";
import type { ChecklistItem } from "./lib/api";
import Icon from "./Icon";

function ItemRow({ item, index, disabled, onUpdate, onRemove }: {
  item: ChecklistItem; index: number; disabled: boolean;
  onUpdate(value: Partial<ChecklistItem>): void; onRemove(): void;
}) {
  const [text, setText] = useState(item.text);
  useEffect(() => { setText(item.text); }, [item.text]);
  const commit = () => {
    const next = text.trim();
    if (next === item.text) return;
    if (!next) { setText(item.text); return; }
    onUpdate({ text: next });
  };
  return <li className={item.done ? "done" : ""}>
    <input type="checkbox" aria-label={`完成第 ${index + 1} 项`} checked={item.done} disabled={disabled} onChange={e => onUpdate({ done: e.target.checked })} />
    <input className="checklist-text" aria-label={`第 ${index + 1} 项内容`} value={text} maxLength={500} placeholder="清单项内容" disabled={disabled}
      onChange={e => setText(e.target.value)} onBlur={commit}
      onKeyDown={e => {
        if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
        if (e.key === "Escape") { setText(item.text); (e.target as HTMLInputElement).blur(); }
      }} />
    <button type="button" className="icon-ghost" aria-label={`删除第 ${index + 1} 项`} title="删除" disabled={disabled} onClick={onRemove}><Icon name="close" /></button>
  </li>;
}

/** 清单：勾选、改文字、删除都即时生效，不再需要「保存」 */
export default function Checklist({ items, onChange, disabled = false }: { items: ChecklistItem[]; onChange(items: ChecklistItem[]): void; disabled?: boolean }) {
  const [text, setText] = useState("");
  const update = (id: string, value: Partial<ChecklistItem>) => onChange(items.map(item => item.id === id ? { ...item, ...value } : item));
  const add = () => {
    const next = text.trim();
    if (!next || items.length >= 100) return;
    onChange([...items, { id: crypto.randomUUID(), text: next, done: false }]);
    setText("");
  };
  const done = items.filter(i => i.done).length;
  return <section className="read-checklist">
    <h3>清单 · {done}/{items.length}</h3>
    {items.length > 0 && <progress value={done} max={items.length} aria-label="清单完成进度" />}
    {items.length > 0 && <ul>{items.map((item, index) => <ItemRow key={item.id} item={item} index={index} disabled={disabled} onUpdate={value => update(item.id, value)} onRemove={() => onChange(items.filter(i => i.id !== item.id))} />)}</ul>}
    <form className="checklist-add" onSubmit={e => { e.preventDefault(); add(); }}>
      <input value={text} maxLength={500} placeholder="添加清单项…" aria-label="新清单项" disabled={disabled} onChange={e => setText(e.target.value)} />
      <button type="submit" className="primary" disabled={disabled || !text.trim() || items.length >= 100}><Icon name="plus" />添加</button>
    </form>
  </section>;
}
