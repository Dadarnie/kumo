// SPDX-License-Identifier: MIT
import { State } from "../core/state";
import { codingLabel } from "../core/coding";
import { Sound } from "../core/sound";
import { PANEL_H, VIEW_LAYOUTS, washRGBA } from "../core/layout";
import type { AgentQuestion } from "../core/agent-question";
import { h } from "./dom";
import { ICONS, icon } from "./icons";
import { naturalHeight } from "./content-size";
import type { ViewActions, ViewHost } from "./views";
import "./agent-question.css";

interface Draft { index:number; selected:string[][]; text:string[]; busy:boolean; error:string }

/** One focused question at a time, within the permission panel's existing shell. */
export function buildAgentQuestion(actions: ViewActions): ViewHost {
  const project=h('span',{class:'coding-project'});
  const progress=h('span',{class:'question-progress'});
  const provider=h('span',{class:'coding-approval-provider'});
  const heading=h('div',{class:'coding-approval-heading'},project,progress);
  const status=h('div',{class:'coding-approval-status'},icon(ICONS.bubble,13),provider,h('span',{text:'Needs your answer'}));
  const title=h('div',{class:'question-title',id:'agent-question-title'});
  const options=h('div',{class:'question-options'});
  const content=h('div',{class:'question-content',tabindex:'-1'},title,options);
  const input=h('input',{class:'chat-input question-input',type:'text',maxlength:'2000',placeholder:'Or type your answer…','aria-label':'Your answer',autocomplete:'off'});
  const composer=h('div',{class:'chat-bar question-composer'},input);
  const error=h('div',{class:'question-error',role:'alert',hidden:true});
  const returnButton=h('button',{class:'btn secondary question-return',type:'button',text:'Answer in tool',onclick:()=>actions.returnQuestion()});
  const previous=h('button',{class:'btn secondary question-previous',type:'button',text:'Back',hidden:true,onclick:()=>{
    const draft=currentDraft();if(!draft||draft.busy||!draft.index)return;Sound.play('close');draft.index--;rendered='';sync();
  }});
  const send=h('button',{class:'btn primary question-send',type:'submit',text:'Send answer',disabled:true});
  const row=h('div',{class:'actions question-actions'},returnButton,h('span',{class:'grow'}),previous,send);
  const body=h('form',{class:'coding-approval agent-question'},heading,status,content,composer,error,row);
  const surface=h('div',{class:'card wash'},body);surface.style.setProperty('--wash',washRGBA('cyan'));
  const el=h('div',{class:'view question-view','aria-label':'Coding assistant question'},surface);
  const drafts=new Map<string,Draft>();
  let rendered='',measured='',height=VIEW_LAYOUTS.question.height;
  let choices:{input:HTMLInputElement;label:string}[]=[];

  const currentRequest=()=>State.pendingApproval?.questions ? State.pendingApproval : null;
  const currentDraft=()=>{const request=currentRequest();return request ? drafts.get(request.requestId) : undefined;};
  function answer(draft:Draft,index:number,question:AgentQuestion):string {
    const typed=draft.text[index].trim();
    if(!question.multiSelect&&typed)return typed;
    return [...draft.selected[index],...(typed?[typed]:[])].join(', ');
  }
  function updateControls() {
    const request=currentRequest(),draft=currentDraft();
    const question=request?.questions?.[draft?.index??0];
    send.hidden=composer.hidden=!request;
    previous.hidden=!draft?.index;
    returnButton.disabled=!!draft?.busy;
    previous.disabled=!!draft?.busy;
    input.disabled=!!draft?.busy;
    for(const choice of choices){choice.input.disabled=!!draft?.busy;choice.input.checked=!!draft?.selected[draft.index].includes(choice.label);}
    send.disabled=!draft||!question||draft.busy||!answer(draft,draft.index,question);
    send.textContent=draft?.busy?'Sending…':request?.questions&&draft&&draft.index<request.questions.length-1?'Continue':'Send answer';
    error.textContent=draft?.error??'';error.hidden=!draft?.error;
    body.setAttribute('aria-busy',String(!!draft?.busy));
  }
  async function submit() {
    const request=currentRequest(),draft=currentDraft();
    if(!request?.questions||!draft||draft.busy)return;
    if(!answer(draft,draft.index,request.questions[draft.index]))return;
    if(draft.index<request.questions.length-1){draft.index++;rendered='';sync();input.focus();return;}
    const answers=Object.fromEntries(request.questions.map((question,index)=>[question.question,answer(draft,index,question)]));
    if(Object.values(answers).some(value=>!value))return;
    draft.busy=true;draft.error='';updateControls();
    try{await actions.answerQuestion(request.requestId,answers);}
    catch(cause){draft.error=cause instanceof Error?cause.message:'Could not send your answer. Try again or answer in your tool.';}
    finally{draft.busy=false;updateControls();if(State.view==='question')State.notify();}
  }
  body.addEventListener('submit',event=>{event.preventDefault();void submit();});
  input.addEventListener('input',()=>{
    const draft=currentDraft(),question=currentRequest()?.questions?.[draft?.index??0];
    if(!draft||!question)return;draft.text[draft.index]=input.value;draft.error='';
    if(!question.multiSelect&&input.value.trim())draft.selected[draft.index]=[];
    updateControls();
  });
  function sync() {
    const request=currentRequest();
    for(const key of drafts.keys())if(!State.pendingApprovals.some(request=>request.requestId===key))drafts.delete(key);
    const task=State.tasks.find(task=>task.id===request?.taskId)??State.focusTask;
    project.textContent=task?.name||'Coding session';project.title=task?.sessionCwd??'';
    provider.textContent=codingLabel(task);
    let draft:Draft|undefined;
    if(request?.questions){
      draft=drafts.get(request.requestId);
      if(!draft){draft={index:0,selected:request.questions.map(()=>[]),text:request.questions.map(()=>''),busy:false,error:''};drafts.set(request.requestId,draft);}
    }
    const question=request?.questions?.[draft?.index??0];
    const key=JSON.stringify([request?.requestId,task?.id,draft?.index,question,request?null:task?.steps.at(-1)]);
    if(key!==rendered){
      rendered=key;choices=[];options.replaceChildren();input.value=draft?.text[draft.index]??'';
      title.textContent=question?.question??task?.steps.at(-1)??'Your coding assistant needs an answer.';
      progress.textContent=request?.questions&&request.questions.length>1?`${(draft?.index??0)+1} of ${request.questions.length}`:'';
      options.setAttribute('role',question?.multiSelect?'group':'radiogroup');options.setAttribute('aria-labelledby','agent-question-title');
      for(const option of question?.options??[]){
        const control=h('input',{type:question?.multiSelect?'checkbox':'radio',name:'agent-question-answer',value:option.label});
        choices.push({input:control,label:option.label});
        control.addEventListener('change',()=>{
          const draft=currentDraft();if(!draft||draft.busy)return;
          draft.selected[draft.index]=question?.multiSelect?choices.filter(choice=>choice.input.checked).map(choice=>choice.label):[option.label];
          if(!question?.multiSelect){draft.text[draft.index]='';input.value='';}
          draft.error='';updateControls();
        });
        options.append(h('label',{class:'question-option'},control,h('span',{},h('b',{text:option.label}),option.description?h('span',{class:'question-option-detail',text:option.description}):null)));
      }
      const fallback=!request;
      options.hidden=fallback;composer.hidden=fallback;
      if(fallback)options.append(h('p',{class:'question-tool-hint',text:'Open your tool to answer and continue.'}));
      content.scrollTop=0;
    }
    updateControls();
    const measurement=JSON.stringify([key,body.offsetWidth,draft?.error]);
    if(measurement!==measured){
      measured=measurement;
      const next=Math.min(PANEL_H,Math.max(VIEW_LAYOUTS.question.height,54+naturalHeight(body)));
      if(next!==height){height=next;queueMicrotask(()=>{if(State.view==='question')State.notify();});}
    }
  }
  return {el,sync,layout:()=>({...VIEW_LAYOUTS.question,height}),focus:()=>{(currentRequest()?(options.querySelector<HTMLInputElement>('input')??input):returnButton).focus({preventScroll:true});}};
}
