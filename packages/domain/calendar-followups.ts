import { z } from 'zod';
import { localEventInputSchema, type LocalCalendarEvent, type LocalEventInput } from './calendar.js';
import { clockInZone } from './calendar-time.js';
import { dayInZone, timezone } from './tasks.js';
import { reminderInstant } from './reminders.js';
import { mailSourceSchema } from './mail-contact.js';

export const mailCalendarSourceSchema=mailSourceSchema;
export type MailCalendarSource=z.infer<typeof mailCalendarSourceSchema>;
export const calendarFollowupSchema=z.object({requestId:z.uuid(),epoch:z.uuid(),source:mailCalendarSourceSchema,generation:z.uuid(),title:z.string().trim().min(1).max(300),notes:z.string().max(10000),startAt:z.iso.datetime(),endAt:z.iso.datetime(),timezone,reminderMinutes:localEventInputSchema.shape.reminderMinutes,deliveryChannel:localEventInputSchema.shape.deliveryChannel,after:z.object({eventId:z.uuid(),revision:z.number().int().positive()}).strict().optional()}).strict().refine(command=>Date.parse(command.startAt)%60000===0&&Date.parse(command.endAt)%60000===0&&Date.parse(command.endAt)>Date.parse(command.startAt)&&Date.parse(command.endAt)-Date.parse(command.startAt)<=86400000,'Choose complete minute times and an end within one day after the start.');
export type CalendarFollowupCommand=z.infer<typeof calendarFollowupSchema>;
export type CalendarFollowupResult={epoch:string;requestId:string;source:MailCalendarSource;created:boolean;event:LocalCalendarEvent};
export const mailCalendarKey=(source:MailCalendarSource)=>JSON.stringify([source.provider,source.accountId,source.threadId]);
function wall(iso:string,zone:string):LocalEventInput['start'] {
  const instant=Date.parse(iso),value={date:dayInZone(zone,instant),time:clockInZone(iso,zone)},resolution=reminderInstant({...value,timezone:zone});
  if(resolution.choices.length>1)return {...value,overlap:Math.abs(resolution.choices[0]-instant)<60000?'earlier':'later'};
  return value;
}
export function followupEventValue(command:CalendarFollowupCommand):LocalEventInput {
  return {title:command.title,notes:command.notes,location:'',timezone:command.timezone,allDay:false,start:wall(command.startAt,command.timezone),end:wall(command.endAt,command.timezone),state:'confirmed',projectId:null,taskId:null,category:'work',reminderMinutes:command.reminderMinutes??0,deliveryChannel:command.deliveryChannel??'last'};
}
