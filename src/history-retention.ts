// Archive conversations and outcomes, not a second copy of the harness trace.
export function retainedEvent(value:any):any|null {
  if(!value||typeof value!=='object')return value;
  if(value.type==='message') {
    if(value.platform==='legacy'&&value.author==='toolResult')return null;
    const {raw,...message}=value;return message;
  }
  if(value.type==='legacy') {
    const message=value.event?.message;
    if(!message||!['user','assistant','system'].includes(message.role))return null;
    const content=typeof message.content==='string'?message.content:(message.content??[]).filter((c:any)=>c.type==='text').map((c:any)=>c.text??'').join('\n');
    if(!content)return null;
    return {...value,event:{message:{role:message.role,content,senderName:message.senderName,senderId:message.senderId}}};
  }
  if(value.type!=='codex')return value;
  const event=value.event??{},p=event.params??{},item=p.item;
  const params:any={threadId:p.threadId,turnId:p.turnId};
  if(event.method==='item/completed'&&item?.type==='agentMessage') {
    params.item={id:item.id,type:item.type,phase:item.phase,text:item.text};
  } else if(event.method==='turn/completed') {
    params.turn={id:p.turn?.id,status:p.turn?.status,error:briefError(p.turn?.error)};
  } else if(event.method==='error') {
    params.error=briefError(p.error);params.willRetry=p.willRetry;
  } else if(event.method==='item/completed'&&item&&(item.status==='failed'||item.exitCode!=null&&item.exitCode!==0||item.error||item.result?.isError)) {
    params.item={id:item.id,type:item.type,server:item.server,tool:item.tool,status:item.status,exitCode:item.exitCode,error:briefError(item.error??{message:'Tool failed; raw output was not retained.'})};
  } else return null;
  return {...value,event:{method:event.method,params}};
}
function briefError(error:any) {
  if(!error)return undefined;
  return {message:String(typeof error==='string'?error:error.message??'Unknown error').slice(0,2000),code:typeof error.code==='string'||typeof error.code==='number'?error.code:undefined};
}
