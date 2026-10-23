import { readFileSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { z } from 'zod';

export type Workspace = string;
export interface Route { conversationMode?: 'channel'; requireMention?: boolean; account: string; guild: string; channel: string; workspace: Workspace; model: string; effort: string }
export interface Config {
  dataDir: string; secretsDir: string; codex: string; codexHome: string;
  workspaces: Record<Workspace, string>; routes: Route[]; whatsappGroup: string; concurrency: number;
  whatsappWorkspace?: string; whatsappAccount?: string; whatsappModel?: string; whatsappEffort?: string;
  timezone?: string; historyRetention?: boolean;
  taskDispatch?: { account:string; channel:string };
  agent?: { name?: string; instructions?: string; sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access' };
  runtime?: { source: string; revision: string; configPath: string; loader: string };
}
const name=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/).refine(value=>!['__proto__','constructor','prototype'].includes(value));
const path=z.string().min(1).refine(isAbsolute,'Use an absolute filesystem path');
const nonempty=z.string().min(1);
const schema=z.object({
  dataDir:path,secretsDir:path,codex:path,codexHome:path,
  workspaces:z.record(name,path).refine(value=>Object.keys(value).length>0,'Configure at least one workspace'),
  routes:z.array(z.object({account:name,guild:nonempty,channel:nonempty,workspace:name,model:nonempty,effort:nonempty,conversationMode:z.literal('channel').optional(),requireMention:z.boolean().optional()}).strict()),
  whatsappGroup:z.string().default(''),whatsappWorkspace:name.optional(),whatsappAccount:name.optional(),whatsappModel:nonempty.optional(),whatsappEffort:nonempty.optional(),
  concurrency:z.number().int().min(1).max(32).default(2),timezone:z.string().refine(value=>{try{new Intl.DateTimeFormat('en',{timeZone:value});return true;}catch{return false;}},'Invalid IANA timezone').default('UTC'),
  historyRetention:z.boolean().default(false),
  taskDispatch:z.object({account:name,channel:nonempty}).strict().optional(),
  agent:z.object({name:nonempty.optional(),instructions:z.string().optional(),sandbox:z.enum(['read-only','workspace-write','danger-full-access']).default('workspace-write')}).strict().optional(),
  runtime:z.object({source:path,revision:nonempty,configPath:path,loader:path}).strict().optional(),
}).strict();
export function parseConfig(value:unknown):Config {
  const config=schema.parse(value);
  for(const route of config.routes)if(!Object.hasOwn(config.workspaces,route.workspace))throw new Error('Route references an unknown workspace');
  const keys=config.routes.map(route=>JSON.stringify([route.account,route.guild,route.channel]));
  if(new Set(keys).size!==keys.length)throw new Error('Duplicate Discord route');
  if(config.whatsappGroup&&(!config.whatsappWorkspace||!Object.hasOwn(config.workspaces,config.whatsappWorkspace)||!config.whatsappAccount||!config.whatsappModel||!config.whatsappEffort))throw new Error('WhatsApp requires a configured workspace, account, model and effort');
  if(config.taskDispatch&&!config.routes.some(route=>route.account===config.taskDispatch!.account&&route.channel===config.taskDispatch!.channel))throw new Error('Task dispatch requires an enabled Discord route');
  return config;
}
export function loadConfig(path=resolve(process.env.RAJESH_CONFIG ?? 'config.json')):Config {
  return parseConfig(JSON.parse(readFileSync(path,'utf8')));
}
export function routeFor(config: Config, account: string, guild: string, channel: string): Route | undefined {
  return config.routes.find(r => r.account === account && r.guild === guild && r.channel === channel)
    ?? config.routes.find(r => r.account === account && r.guild === '*' && r.channel === channel);
}
