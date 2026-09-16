import { useState } from 'react';
import type { Entity, Snapshot } from '../../../packages/domain/contracts';
import { addDays, calendarWindow } from '../../../packages/domain/calendar';
import { contentDay } from '../../../packages/domain/content-planning';
import { contentStages, type Content } from '../../../packages/domain/workspace-records';
import { dayInZone, localDate } from '../../../packages/domain/tasks';
import { readLocal, saveLocal } from './api';
import { retainedWindowId } from './useWorkspace';
import { useContentPlanning } from './useContentPlanning';
import { Plus, ArrowRight } from './icons';
import './content-planning.css';
export type ContentSeed = Pick<Content, 'stage' | 'plannedDate'>;
type Props = { snapshot: Snapshot; records: Entity<Content>[]; refresh: () => Promise<void>; selected: string | null; open: (id: string, element?: HTMLElement) => void; create: (seed?: Partial<ContentSeed>) => void; publication: (id: string) => void; view: 'board' | 'calendar' | 'list'; };
const titleStage = (stage: string) => stage[0].toUpperCase() + stage.slice(1);
const dateLabel = (date: string) => new Date(date + 'T12:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
// Reuses DC ContentPipelinePage's stage columns, cards, drops and date grouping,
// with the existing E3 saved-record and manual-publication boundaries.
export function ContentPlanning({ snapshot, records, refresh, selected, open, create, publication, view }: Props) {
  const control = useContentPlanning(snapshot, refresh, open), today = dayInZone(snapshot.layout.value.timezone);
  const key = `e3:content-month:${snapshot.deviceId}:${retainedWindowId}`;
  const [day, setDay] = useState(() => { const kept = readLocal<string>(key); return kept && localDate.safeParse(kept).success ? kept : today; });
  const [viewError, setViewError] = useState('');
  const month = day.slice(0, 7), range = calendarWindow(month + '-01', 'month');
  const days = Array.from({ length: 42 }, (_, i) => addDays(range.from, i));
  const keepDay = (value: string) => { if (!localDate.safeParse(value).success) return; if (!saveLocal(key, value)) { setViewError('Free browser storage before changing the retained Content date.'); return; } setViewError(''); setDay(value); };
  const turnMonth = (direction: number) => { const value = new Date(month + '-15T12:00:00Z'); value.setUTCMonth(value.getUTCMonth() + direction); if (value.getUTCFullYear() > 0 && value.getUTCFullYear() <= 9999) keepDay(value.toISOString().slice(0, 7) + '-01'); };
  const blocked = (id: string) => Object.values(control.moves).some(move => move.command.entityId === id);
  const dragType = 'application/x-edition3-content';
  const drop = (event: React.DragEvent, patch: { stage?: Content['stage']; plannedDate?: string }) => {
    event.preventDefault();
    try {
      const item = JSON.parse(event.dataTransfer.getData(dragType));
      if (item.epoch !== snapshot.epoch) return;
      const record = records.find(record => record.id === item.id && record.revision === item.revision);
      if (!record || blocked(record.id)) return;
      if (patch.stage === 'published') publication(record.id); else control.move(record, patch as { stage?: Exclude<Content['stage'], 'published'>; plannedDate?: string });
    } catch { /* An unrelated drag is not a Content command. */ }
  };
  const dragOver = (event: React.DragEvent) => { if (event.dataTransfer.types.includes(dragType)) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } };
  const card = (record: Entity<Content>) => <article key={record.id} className="card content-card" data-content-id={record.id} draggable={!record.value.archived && !blocked(record.id)} onDragStart={event => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData(dragType, JSON.stringify({ id: record.id, revision: record.revision, epoch: snapshot.epoch })); }}>
    <button className="content-card-open" aria-pressed={record.id === selected} onClick={e => open(record.id, e.currentTarget)}><strong>{record.value.title}</strong>{record.value.brief && <span className="content-card-brief">{record.value.brief}</span>}<small>{record.value.platform}{record.value.projectId ? ` · ${snapshot.projects.find(p => p.id === record.value.projectId)?.value.name ?? 'Project unavailable'}` : ''}</small><small>{record.value.stage === 'published' ? 'Published · manual record' : 'Planned'} · {contentDay(record.value) ? dateLabel(contentDay(record.value)) : 'No date'}</small></button>
    <label className="content-card-stage">Stage<select aria-label={`Stage for ${record.value.title}`} value={record.value.stage} disabled={record.value.archived || blocked(record.id)} onChange={event => { const stage = event.target.value as Content['stage']; if (stage === 'published') publication(record.id); else control.move(record, { stage }); }}>{contentStages.map(stage => <option key={stage} value={stage}>{titleStage(stage)}</option>)}</select></label>
    {blocked(record.id) && <p className="metadata">A planning request is retained below.</p>}
  </article>;
  return <div className="content-planning">
    {(control.error || viewError) && <p role="alert" className="field-error">{control.error || viewError}</p>}
    {Object.entries(control.moves).length > 0 && <section className="card content-moves" aria-label="Retained Content moves"><h3>Retained planning requests</h3>{Object.entries(control.moves).map(([id, move]) => <div key={id}><p><strong>{move.title}</strong> · {move.patch.stage ? `Move to ${move.patch.stage}` : move.patch.plannedDate ? `Plan for ${dateLabel(move.patch.plannedDate)}` : 'Remove planned date'}</p>{move.error && <p role="status">{move.error}</p>}<div className="button-row">{move.state === 'pending' ? <button disabled={control.busy.includes(id)} onClick={() => void control.check(move)}>{control.busy.includes(id) ? 'Checking move…' : 'Check original move'}</button> : <><button onClick={() => open(move.command.entityId)}>Review current record</button><button onClick={() => control.dismiss(id)}>Dismiss rejected move</button></>}</div></div>)}</section>}
    {view === 'list' ? null : view === 'board' ? <div className="content-board-scroll"><div className="content-board" aria-label="Content stage board">{contentStages.map(stage => { const items = records.filter(record => record.value.stage === stage); return <section key={stage} className="content-column" aria-label={`${titleStage(stage)} stage`} onDragOver={dragOver} onDrop={event => drop(event, { stage })}><header><h3>{titleStage(stage)} <span>{items.length}</span></h3><button aria-label={`Add to ${stage}`} onClick={() => create({ stage })}><Plus size={18}/></button></header><div className="content-column-cards">{items.map(card)}{!items.length && <p className="metadata content-empty">No matching content in this stage.</p>}</div></section>; })}</div></div> : <>
      <div className="content-calendar-toolbar"><div className="button-row"><button aria-label="Previous Content month" disabled={month === '0001-01'} onClick={() => turnMonth(-1)}><span style={{ display: 'inline-flex', transform: 'rotate(180deg)' }}><ArrowRight size={18}/></span></button><h3>{new Date(month + '-15T12:00:00Z').toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })}</h3><button aria-label="Next Content month" disabled={month === '9999-12'} onClick={() => turnMonth(1)}><ArrowRight size={18}/></button><button onClick={() => keepDay(today)}>Today</button></div><div className="button-row"><label>New content date<input type="date" value={day} onChange={event => keepDay(event.target.value)}/></label><button onClick={() => create({ plannedDate: day })}><Plus size={18}/>New for this date</button></div></div>
      <div className="content-calendar" aria-label="Content calendar"><div className="content-weekdays" aria-hidden="true">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(name => <span key={name}>{name}</span>)}</div><div className="content-calendar-days">{days.map(date => { const items = records.filter(record => contentDay(record.value) === date); return <section key={date} className={`content-day${items.length ? '' : ' is-empty'}${date === day ? ' is-selected' : ''}${date.slice(0, 7) === month ? '' : ' is-outside'}`} aria-label={dateLabel(date)} onDragOver={dragOver} onDrop={event => drop(event, { plannedDate: date })}><header><time dateTime={date}>{dateLabel(date)}</time><button aria-label={`Add content for ${dateLabel(date)}`} onClick={() => create({ plannedDate: date })}><Plus size={16}/></button></header>{items.map(card)}</section>; })}</div></div>
      <section className="content-unscheduled" aria-label="Content without dates" onDragOver={dragOver} onDrop={event => drop(event, { plannedDate: '' })}><h3>No planned date</h3><div>{records.filter(record => !contentDay(record.value)).map(card)}</div>{!records.some(record => !contentDay(record.value)) && <p className="metadata">Every matching item has a date.</p>}</section>
    </>}
  </div>;
}
