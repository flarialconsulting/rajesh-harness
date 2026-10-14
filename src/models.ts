import { Rpc } from './rpc.js';
import type { Config } from './config.js';
import { Store } from './store.js';
export interface Model {id:string;model:string;defaultReasoningEffort?:string;supportedReasoningEfforts?:{reasoningEffort:string}[];serviceTiers?:{id:string}[];additionalSpeedTiers?:string[]}
const supportsUltrafast=(model:Model|undefined)=>model?.serviceTiers?.some(t=>t.id==='ultrafast')||model?.additionalSpeedTiers?.includes('ultrafast');
export class ModelCommands {
  constructor(public config:Config,public store:Store,public factory=(binary:string)=>new Rpc(binary,[],{...process.env,CODEX_HOME:config.codexHome})){}
  async list(taskKey?:string):Promise<Model[]> {
    const hasExecutions=this.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='runtime_executions'").get();
    const binding=taskKey?(hasExecutions?this.store.db.prepare('SELECT configPath FROM runtime_executions WHERE task=?').get(taskKey):undefined)??this.store.db.prepare('SELECT configPath FROM runtime_bindings WHERE task=?').get(taskKey):undefined;
    let binary=this.config.codex;
    if(binding){const {readFileSync}=await import('node:fs');binary=JSON.parse(readFileSync(String(binding.configPath),'utf8')).codex;}
    const rpc=this.factory(binary);
    try{await rpc.initialize();let cursor:string|null=null;const models:Model[]=[];
      do{const page=await rpc.request('model/list',{includeHidden:true,cursor});models.push(...page.data);cursor=page.nextCursor??null;}while(cursor);
      return models;
    }finally{rpc.close();}
  }
  async run(text:string,taskKey?:string,defaultKey?:string,fallback?:{model:string;effort:string}) {
    const [command,name,effort,...extra]=text.trim().split(/\s+/);
    if(!['/models','/model','/status','/ultrafast'].includes(command))return null;
    const task=taskKey?this.store.task(taskKey):undefined;
    const current=task??(defaultKey?this.store.meta(defaultKey):undefined)??fallback;
    const tier=task?this.store.meta(`taskServiceTier:${task.key}`):undefined;
    if(command==='/ultrafast') {
      if(effort||extra.length||(name!==undefined&&name!=='on'&&name!=='off'))return 'Use /ultrafast, /ultrafast on, or /ultrafast off.';
      if(!task||task.platform!=='discord'||task.channel===task.parent)return 'Use /ultrafast inside the task thread you want to change.';
      const enabled=name!=='off';
      if(enabled) {
        const models=await this.list(taskKey);
        const selected=this.store.task(task.key);
        if(!supportsUltrafast(models.find(m=>m.model===selected?.model||m.id===selected?.model)))return `Ultrafast is unavailable for ${selected?.model??'the selected model'}. Use /model to choose one of: ${models.filter(supportsUltrafast).map(m=>m.model).join(', ')||'none available'}.`;
      }
      const serviceTier=enabled?'ultrafast':'default';
      this.store.meta(`taskServiceTier:${task.key}`,serviceTier);
      return `Ultrafast ${enabled?'enabled':'disabled'}. Applies from the next turn in this thread. Model and reasoning are unchanged.`;
    }
    if(command==='/status') {
      const running=Number(this.store.db.prepare("SELECT count(*) n FROM tasks WHERE status='running'").get()!.n);
      const queued=Number(this.store.db.prepare("SELECT count(DISTINCT task) n FROM jobs WHERE state='queued'").get()!.n);
      return `Running tasks: ${running} · Queued tasks: ${queued}\nModel: ${current?.model??'not selected'} / ${current?.effort??'default'}${task?'':' (new-task default)'}\nService tier preference: ${tier??'automatic'}`;
    }
    if(command==='/model'&&!name)return `Model: ${current?.model??'not selected'} / ${current?.effort??'default'}\nUse /model MODEL [REASONING]. ${task?'Changes this conversation.':'Changes the default for new tasks in this channel.'}`;
    if(extra.length||(command==='/models'&&name))return 'Usage: /models or /model MODEL [REASONING]';
    const models=await this.list(taskKey);
    if(command==='/models')return `Available models${task?' for this conversation’s current Codex version':''}:\n`+models.map(m=>`${m.model} — ${(m.supportedReasoningEfforts??[]).map(e=>e.reasoningEffort).join(', ')}${supportsUltrafast(m)?' · ultrafast':''}`).join('\n');
    const model=models.find(m=>m.model===name||m.id===name);
    if(!model)return `Unavailable model: ${name}. Use /models to see exact model IDs.`;
    const latestTier=task?this.store.meta(`taskServiceTier:${task.key}`):undefined;
    if(latestTier==='ultrafast'&&!supportsUltrafast(model))return `${model.model} does not support ultrafast. Turn ultrafast off before selecting it with /ultrafast off.`;
    const supported=(model.supportedReasoningEfforts??[]).map(e=>e.reasoningEffort);
    const selected=effort??(supported.includes(current?.effort)?current.effort:model.defaultReasoningEffort??supported[0]);
    if(!selected||!supported.includes(selected))return `Unsupported reasoning for ${model.model}. Choose: ${supported.join(', ')}.`;
    if(task) {
      const fresh=this.store.task(task.key)!;
      if(fresh.status==='running'||this.store.db.prepare("SELECT id FROM jobs WHERE task=? AND state IN ('running','steering') LIMIT 1").get(task.key))return 'Wait for this turn to finish, or use /stop, before changing models.';
      this.store.db.prepare('UPDATE tasks SET model=?,effort=? WHERE key=?').run(model.model,selected,task.key);
    }else if(defaultKey)this.store.meta(defaultKey,{model:model.model,effort:selected});
    else return 'Start a conversation before changing its model.';
    return `Model set to ${model.model} / ${selected}. ${task?'Applies to the next turn in this conversation.':'Applies to new tasks in this channel.'}`;
  }
  async register(client:any) {
    const guilds=new Set<string>();
    for(const route of this.config.routes) {
      if(route.guild!=='*')guilds.add(route.guild);
    }
    for(const guildId of guilds) {
      const guild=await client.guilds.fetch(guildId).catch(()=>null);if(!guild)continue;
      await guild.commands.create({name:'models',description:'List available Codex models and reasoning levels'});
      await guild.commands.create({name:'stop',description:'Force stop this task and cancel queued input'});
      await guild.commands.create({name:'status',description:'Show running tasks, server health, and this conversation’s model'});
      await guild.commands.create({name:'ultrafast',description:'Enable or disable ultrafast for this task thread',options:[{name:'enabled',description:'True enables ultrafast; false returns to standard speed (default: true)',type:5,required:false}]});
      await guild.commands.create({name:'model',description:'Show or change this conversation’s model, or the channel default',options:[{name:'model',description:'Exact model ID from /models',type:3,required:false},{name:'reasoning',description:'Reasoning level supported by the selected model',type:3,required:false}]});
    }
  }
  async interaction(account:string,i:any,stop?:(key:string)=>Promise<string>) {
    if(!i.isChatInputCommand())return;
    if(!['models','model','status','stop','ultrafast'].includes(i.commandName)){if(i.deferred)await i.editReply('This command is unavailable.');return;}
    const parent=i.channel?.isThread()?i.channel.parentId:i.channelId;
    const route=this.config.routes.find(r=>r.account===account&&r.channel===parent&&(r.guild==='*'||r.guild===i.guildId));
    if(!route){if(i.deferred)await i.editReply('This channel is not enabled for this bot.');else await i.reply({content:'This channel is not enabled for this bot.',flags:64});return;}
    if(!i.deferred)await i.deferReply({flags:64});
    try {
      if(i.commandName==='ultrafast'&&!i.channel?.isThread()){await i.editReply('Use /ultrafast inside the task thread you want to change.');return;}
      const taskKey=i.channel?.isThread()?`discord:${account}:${i.channelId}`:undefined;
      if(taskKey&&!this.store.task(taskKey)){await i.editReply('This thread has no bot conversation. Mention the bot in its parent channel to start one.');return;}
      if(i.commandName==='stop'){await i.editReply(taskKey&&stop?await stop(taskKey):'Use /stop inside the task thread you want to stop.');return;}
      if(i.commandName==='ultrafast') {
        const enabled=i.options.getBoolean('enabled')??true;
        await i.editReply(await this.run(`/ultrafast ${enabled?'on':'off'}`,taskKey,`modelDefault:discord:${account}:${parent}`,route));return;
      }
      const name=i.options.getString('model'),reasoning=i.options.getString('reasoning');
      if(reasoning&&!name){await i.editReply('Choose a model when specifying reasoning.');return;}
      const output=await this.run(`/${i.commandName}${name?' '+name:''}${reasoning?' '+reasoning:''}`,taskKey,`modelDefault:discord:${account}:${parent}`,route);
      const {splitMessage}=await import('./discord.js');const chunks=splitMessage(output??'Unknown command');
      await i.editReply(chunks[0]);for(const content of chunks.slice(1))await i.followUp({content,flags:64});
    }catch{await i.editReply('Could not load or change the model. Please retry.');}
  }
}
