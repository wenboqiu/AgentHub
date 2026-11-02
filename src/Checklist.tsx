import type { ChecklistItem } from './lib/api';

export default function Checklist({items,onChange}:{items:ChecklistItem[];onChange(items:ChecklistItem[]):void}) {
  const update=(id:string,value:Partial<ChecklistItem>)=>onChange(items.map(item=>item.id===id ? {...item,...value} : item));
  return <fieldset className="checklist"><legend>Checklist · {items.filter(i=>i.done).length}/{items.length}</legend>
    {items.length > 0 && <progress value={items.filter(i=>i.done).length} max={items.length} aria-label="清单完成进度"/>}
    {items.map((item,index)=><div className={`checklist-row ${item.done ? 'completed' : ''}`} key={item.id}>
      <input type="checkbox" aria-label={`完成第 ${index+1} 项`} checked={item.done} onChange={e=>update(item.id,{done:e.target.checked})}/>
      <input aria-label={`第 ${index+1} 项内容`} value={item.text} maxLength={500} required placeholder="填写清单项…" onChange={e=>update(item.id,{text:e.target.value})}/>
      <button type="button" aria-label={`删除第 ${index+1} 项`} onClick={()=>onChange(items.filter(i=>i.id!==item.id))}>删除</button>
    </div>)}
    <button type="button" disabled={items.length>=100} onClick={()=>onChange([...items,{id:crypto.randomUUID(),text:'',done:false}])}>添加清单项</button>
    <p className="dim">勾选和编辑后点击保存；清单进度独立于任务状态。</p>
  </fieldset>;
}
