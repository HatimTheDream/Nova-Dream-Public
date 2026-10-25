import type {Focus} from '../../packages/domain/tasks.js';
import type {DraftCapacityContext} from './feed-draft-capacity.js';

/** Authenticated consumed fields shared by the Task status-stop and focus
 * control programs. Stored owner strings retain their historical domain. */
export function consumedTaskFocus(c:DraftCapacityContext,value:any,id:string):Focus{
 c.need(value!==null&&typeof value==='object'&&!Array.isArray(value),'Task focus malformed');
 c.need(value.taskId===id&&typeof value.revision==='number'&&Number.isSafeInteger(value.revision)&&value.revision>=1&&typeof value.deviceId==='string'&&typeof value.clientId==='string'&&typeof value.running==='boolean'&&typeof value.elapsedMs==='number'&&Number.isFinite(value.elapsedMs)&&value.elapsedMs>=0&&value.elapsedMs<=Number.MAX_SAFE_INTEGER&&typeof value.lastPulse==='number'&&Number.isFinite(value.lastPulse)&&value.lastPulse>=-Number.MAX_SAFE_INTEGER&&value.lastPulse<=Number.MAX_SAFE_INTEGER,'Task focus fields malformed');
 c.key(value.deviceId);c.key(value.clientId);return value;
}
