import type { Schedule } from './lib/api';

export const scheduleOf = (v: Schedule): Schedule => ({startAt:v.startAt ?? null,dueAt:v.dueAt ?? null,remindStart:v.remindStart ?? true,remindDue:v.remindDue ?? true});
// datetime-local uses the device's local timezone; persist an absolute instant.
export function localDateTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}
export function ScheduleSummary({value}:{value:Schedule}) {
  return <>{value.startAt && <span className="dim">开始：{new Date(value.startAt).toLocaleString()}</span>}{value.dueAt && <span className="dim">截止：{new Date(value.dueAt).toLocaleString()}</span>}</>;
}
export default function ScheduleFields({value,onChange}:{value:Schedule;onChange(value:Partial<Schedule>):void}) {
  return <fieldset className="schedule-fields"><legend>时间与提醒</legend><div className="form-grid">
    <label>开始时间<input type="datetime-local" value={localDateTime(value.startAt)} max={localDateTime(value.dueAt) || undefined} onChange={e=>onChange({startAt:e.target.value ? new Date(e.target.value).toISOString() : null})}/></label>
    <label>截止时间<input type="datetime-local" value={localDateTime(value.dueAt)} min={localDateTime(value.startAt) || undefined} onChange={e=>onChange({dueAt:e.target.value ? new Date(e.target.value).toISOString() : null})}/></label>
  </div><div className="action-bar"><label className="check"><input type="checkbox" checked={value.remindStart} disabled={!value.startAt} onChange={e=>onChange({remindStart:e.target.checked})}/>开始时提醒</label><label className="check"><input type="checkbox" checked={value.remindDue} disabled={!value.dueAt} onChange={e=>onChange({remindDue:e.target.checked})}/>截止时提醒</label></div><p className="dim">按本机时区设置。到点后提醒，离线期间到期的提醒会在重连后显示。</p></fieldset>;
}
