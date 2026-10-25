import test from 'node:test';
import assert from 'node:assert/strict';
import {calendarPeriodTitle} from '../apps/client/src/dreamclaw/pages/Calendar/calendarUtils';

test('the Calendar heading follows the current view and configured week boundary',()=>{
 const date=new Date(2026,9,20,12);
 assert.equal(calendarPeriodTitle(date,'month',0),'October 2026');
 assert.equal(calendarPeriodTitle(date,'day',0),'Tuesday, October 20, 2026');
 const sunday=calendarPeriodTitle(date,'week',0),monday=calendarPeriodTitle(date,'week',1);
 assert.match(sunday,/18/);assert.match(sunday,/24/);assert.match(monday,/19/);assert.match(monday,/25/);
 assert.notEqual(sunday,monday);
});
test('a week crossing the year boundary retains both years and does not mutate the selected date',()=>{
 const date=new Date(2027,0,1,12),before=date.getTime(),title=calendarPeriodTitle(date,'week',0);
 assert.match(title,/Dec 27, 2026/);assert.match(title,/Jan 2, 2027/);assert.equal(date.getTime(),before);
});
