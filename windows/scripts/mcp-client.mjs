// SPDX-License-Identifier: MIT
// Minimal diagnostic client for Mimo's local MCP process. Never changes the
// installed configuration or contacts an AI service.
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';

export function mimoMcp(provider, {executable=fileURLToPath(new URL('../target/release/kumo-hook.exe',import.meta.url))}={}) {
  const child=spawn(executable,['--mcp','--provider',provider],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  const pending=new Map(),errors=[];
  let sequence=0,exited=false;
  function fail(cause){for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(cause);}pending.clear();}
  child.on('error',fail);
  child.on('exit',(code)=>{exited=true;fail(new Error('MCP process exited: '+code));});
  child.stderr.on('data',data=>{if(errors.join('').length<10000)errors.push(String(data));});
  const lines=createInterface({input:child.stdout});
  lines.on('line',line=>{
    let message;try{message=JSON.parse(line);}catch{errors.push('Non-JSON stdout');return;}
    if(message.jsonrpc!=='2.0'){errors.push('Invalid JSON-RPC stdout');return;}
    const entry=pending.get(JSON.stringify(message.id));
    if(!entry)return;
    pending.delete(JSON.stringify(message.id));clearTimeout(entry.timer);entry.resolve(message);
  });
  function notify(method,params={}){child.stdin.write(JSON.stringify({jsonrpc:'2.0',method,params})+'\n');}
  function request(method,params={}, {id=++sequence,timeout=5000}={}) {
    return new Promise((resolve,reject)=>{
      if(exited){reject(new Error('MCP process already exited'));return;}
      const key=JSON.stringify(id);
      if(pending.has(key)){reject(new Error('Duplicate diagnostic request id'));return;}
      const timer=setTimeout(()=>{pending.delete(key);reject(new Error(method+' timed out'));},timeout);
      pending.set(key,{resolve,reject,timer});
      child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
    });
  }
  async function initialize(protocolVersion='2025-11-25'){
    const reply=await request('initialize',{protocolVersion,capabilities:{},clientInfo:{name:'mimo-check',version:'1'}});
    if(reply.error)throw new Error(reply.error.message);
    notify('notifications/initialized');return reply.result;
  }
  async function close(){
    if(!exited){
      const done=new Promise(resolve=>child.once('exit',resolve));
      child.stdin.end();const timer=setTimeout(()=>child.kill(),1500);
      await done;clearTimeout(timer);
    }
    lines.close();
  }
  return {request,notify,initialize,close,errors,child};
}
