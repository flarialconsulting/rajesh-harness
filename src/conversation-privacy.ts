import type {Config} from './config.js';
import type {Store,Task} from './store.js';

export function visibleTask(store:Store,source:Task,target:Task,_config?:Config){
 return !store.meta(`privateTask:${target.key}`)||source.key===target.key;
}
