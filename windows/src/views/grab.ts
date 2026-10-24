// SPDX-License-Identifier: MIT
import "./grab.css";
import {h} from "./dom";
import {Bridge,onEvent} from "../core/bridge";
import {Sound} from "../core/sound";
import {backAction} from "../core/navigation-sound";
import {State} from "../core/state";
import {PANEL_H,VIEW_LAYOUTS} from "../core/layout";
import {paintAnnotations,reorderedReferences,validAnnotations,type Annotation,type AnnotationTool,type GrabReference,type GrabSnapshot,type ImageTransform} from "../core/grab";
import {icon,ICONS} from "./icons";
import {fileArtwork,fileKind,fileType} from "./grab-file-art";
import type {ViewHost,ViewActions} from "./views";

/** One visual clipboard. Files stay native; only visible previews enter the WebView. */
export function buildGrab(_actions:ViewActions):ViewHost {
  const el=h("div",{class:"view grab-view"}),surface=h("div",{class:"grab-surface"}),body=h("div",{class:"grab-body"});
  const status=h("div",{class:"grab-status",role:"status","aria-live":"polite"});
  surface.append(body,status);el.append(surface);
  let snapshot:GrabSnapshot={items:[],retentionDays:7,detached:false};
  let visible=false,active=true,busy=false,scene="shelf",instruction="",editorHeight=380;
  let shelfHeight=304,shelfMeasure=0;
  let selected=new Set<string>(),generation=0;
  const stops:(()=>void)[]=[];
  function gridColumns(grid:HTMLElement):number {
    const tracks=getComputedStyle(grid).gridTemplateColumns.trim();
    return tracks&&tracks!=="none"?tracks.split(/\s+/).length:1;
  }
  function measureShelf():void {
    if(!active||!visible||scene!=="shelf")return;
    const grid=body.querySelector<HTMLElement>(".grab-files");if(!grid?.clientWidth)return;
    const style=getComputedStyle(grid),rows=Math.max(1,Math.ceil(snapshot.items.length/gridColumns(grid)));
    const rowHeight=parseFloat(style.getPropertyValue("--grab-file-row-height"))||100;
    const rowGap=parseFloat(style.rowGap)||0;
    const next=Math.min(PANEL_H,304+(rows-1)*(rowHeight+rowGap)+status.offsetHeight);
    if(next===shelfHeight)return;
    shelfHeight=next;State.notify();
  }
  function queueShelfMeasure():void {
    if(!active||!visible||scene!=="shelf"||shelfMeasure)return;
    shelfMeasure=requestAnimationFrame(()=>{shelfMeasure=0;measureShelf();});
  }
  const shelfResize=new ResizeObserver(queueShelfMeasure);
  const button=(label:string,click:()=>void,primary=false,glyph?:string,sound=true)=>h("button",{type:"button",class:"btn "+(primary?"primary":"secondary"),onclick:()=>{if(sound)Sound.play("tick");click();}},glyph?icon(glyph,14):null,h("span",{text:label}));
  const glyphButton=(label:string,glyph:string,click:()=>void,sound=true)=>{
    const b=button(label,click,false,undefined,sound);b.replaceChildren(icon(glyph,15));b.classList.add("grab-icon-button");b.setAttribute("aria-label",label);b.title=label;return b;
  };
  const field=(name:string,value:string,change:(value:string)=>void)=>{
    const input=h("input",{class:"grab-field","aria-label":name,placeholder:name,type:"text",autocomplete:"off",spellcheck:name.includes("note")?"true":"false"});input.value=value;
    if(name==="Reference note")input.placeholder="Add a note (optional)";
    if(name==="Reference name"){input.placeholder="Name this reference";input.classList.add("grab-field-name");}
    if(name==="Collection name")input.placeholder="Collection name";
    if(name==="Note to copy (optional)")input.placeholder="Add instructions for copied files (optional)";
    input.addEventListener("input",()=>change(input.value));return input;
  };
  const message=(value:string,error=false)=>{status.textContent=value;status.dataset.error=String(error);queueShelfMeasure();};
  async function refresh(){
    const id=++generation;
    try {
      const data=await Bridge.grabRead();if(!active||id!==generation||!data)return;
      snapshot=data;selected=new Set([...selected].filter(id=>data.items.some(r=>r.id===id)));
      if(visible&&scene==="shelf"&&!busy)render();
    }catch(error){if(active)message(String(error).replace(/^Error: /,""),true);}
  }
  async function perform<T=unknown>(action:string,args:Record<string,unknown>={},rerender=true):Promise<T|null>{
    if(busy)return null;busy=true;el.dataset.busy="true";message("");
    try {const result=await Bridge.grabAction<T>(action,args);await refresh();if(rerender&&active&&visible)render();return result;}
    catch(error){message(String(error).replace(/^Error: /,""),true);return null;}
    finally{busy=false;delete el.dataset.busy;}
  }
  function thumb(reference:GrabReference):HTMLElement {
    const type=fileType(reference),kind=fileKind(reference);
    return h("span",{class:"grab-thumb","data-type":type,"data-kind":kind},fileArtwork(kind),h("b",{class:"grab-type-label",text:type}));
  }
  function head(title:string,back:()=>void=()=>{scene="shelf";render();}) {
    return h("div",{class:"grab-heading"},glyphButton("Back",ICONS.chevronLeft,backAction(back),false),h("b",{text:title}));
  }
  async function copy(){
    const ids=snapshot.items.filter(r=>!selected.size||selected.has(r.id)).map(r=>r.id);
    if(!ids.length)return;
    const result=await perform<{message:string}>("copy",{ids,instruction},false);
    if(result){Sound.play("pop");message(result.message);}
  }
  function render(){
    body.replaceChildren();el.dataset.scene=scene;State.notify();
    if(scene==="options"){options();return;}if(scene!=="shelf")return;
    const count=snapshot.items.length;
    const copyButton=button("Copy paths",()=>void copy(),false,ICONS.copy);copyButton.classList.add("grab-copy");copyButton.disabled=!count;
    copyButton.title=selected.size?`Copy ${selected.size} selected file${selected.size===1?"":"s"}, with notes`:"Copy all files, with notes";
    const clear=button("Clear",()=>removeFiles(snapshot.items.map(r=>r.id)),false);clear.disabled=!count;
    const header=h("div",{class:"grab-shelf-heading"},h("b",{text:"Drop Shelf"}),h("span",{class:"grab-count",text:`${count} item${count===1?"":"s"}`}),h("span",{class:"grow"}),copyButton,clear);
    const grid=h("div",{class:"grab-files",role:"group","aria-label":"Files on Drop Shelf"});
    for(const [index,r] of snapshot.items.entries()){
      const item=h("div",{class:"grab-file","data-reference":r.id,"data-selected":String(selected.has(r.id))});
      const preview=h("button",{type:"button",class:"grab-file-preview","aria-label":`Preview ${r.label}`,title:[r.label,r.collection,r.width?`${r.width} \u00d7 ${r.height}`:formatSize(r.size),r.duplicateOf?"Similar capture":r.annotated?"Annotated":""].filter(Boolean).join(" \u00b7 "),draggable:"true",onclick:()=>{Sound.play("open");void openReference(r);}},thumb(r),h("span",{class:"grab-file-name",text:r.label}));
      const check=h("input",{class:"grab-file-select",type:"checkbox","aria-label":`Include ${r.label}`});check.checked=selected.has(r.id);
      check.addEventListener("change",()=>{Sound.play("tick");check.checked?selected.add(r.id):selected.delete(r.id);render();body.querySelector<HTMLInputElement>(`.grab-file[data-reference="${CSS.escape(r.id)}"] input`)?.focus();});
      preview.addEventListener("keydown",event=>{
        const columns=gridColumns(grid);let target=index;
        if(event.key==="ArrowRight")target=Math.min(count-1,index+1);
        else if(event.key==="ArrowLeft")target=Math.max(0,index-1);
        else if(event.key==="ArrowDown")target=Math.min(count-1,index+columns);
        else if(event.key==="ArrowUp")target=Math.max(0,index-columns);
        else if(event.key==="Home")target=0;
        else if(event.key==="End")target=count-1;
        else if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="a"){event.preventDefault();selected=new Set(snapshot.items.map(r=>r.id));render();body.querySelector<HTMLButtonElement>(".grab-file-preview")?.focus();return;}
        else return;
        event.preventDefault();if(target!==index)Sound.play("tick");grid.querySelectorAll<HTMLButtonElement>(".grab-file-preview")[target]?.focus();
      });
      preview.addEventListener("dragstart",event=>{event.dataTransfer?.setData("application/x-mimo-reference",r.id);if(event.dataTransfer)event.dataTransfer.effectAllowed="move";});
      item.addEventListener("dragover",event=>{if(event.dataTransfer?.types.includes("application/x-mimo-reference")){event.preventDefault();item.dataset.drop="true";}});
      item.addEventListener("dragleave",()=>delete item.dataset.drop);
      item.addEventListener("drop",event=>{const source=event.dataTransfer?.getData("application/x-mimo-reference");delete item.dataset.drop;if(!source||source===r.id)return;event.preventDefault();void perform("reorder",{ids:reorderedReferences(snapshot.items.map(r=>r.id),source,r.id)});});
      item.append(preview,h("label",{class:"grab-file-select-hit"},check));grid.append(item);
    }
    if(!count)grid.append(h("div",{class:"grab-empty"},icon(ICONS.shelf,26),h("b",{text:"A place for your references."}),h("span",{text:"Drag Kumo to capture, or drop a file on him."})));
    const selectAll=button(selected.size===count&&count?"Deselect all":"Select all",()=>{selected=selected.size===count?new Set():new Set(snapshot.items.map(r=>r.id));render();});selectAll.classList.add("grab-select-all");selectAll.disabled=!count;
    const footer=h("div",{class:"grab-footer grab-shelf-footer"},h("span",{class:"grab-selection-count",text:selected.size?`${selected.size} selected`:""}));
    if(selected.size){footer.append(button("Phone",()=>void Bridge.localsendSendShelf([...selected]).catch(()=>{}),false,ICONS.phone),button("Group",()=>groupFiles()),button("Remove",()=>removeFiles([...selected])));}
    footer.append(h("span",{class:"grow"}),selectAll,glyphButton("Shelf options",ICONS.gear,()=>{scene="options";render();}));
    body.append(header,grid,footer);queueShelfMeasure();
  }
  function formatSize(bytes:number):string{return bytes>=1024*1024?`${(bytes/1024/1024).toFixed(1)} MB`:bytes>=1024?`${Math.round(bytes/1024)} KB`:`${bytes} bytes`;}
  function removeFiles(ids:string[]){
    scene="delete";el.dataset.scene=scene;
    const clear=ids.length===snapshot.items.length,label=ids.length===1?snapshot.items.find(r=>r.id===ids[0])?.label:`${ids.length} files`;
    body.replaceChildren(head(clear?"Clear Drop Shelf":"Remove files"),h("div",{class:"grab-empty"},h("b",{text:clear?"Clear your shelf?":`Remove ${label}?`}),h("span",{text:"Original dropped files stay where they were."})),
      h("div",{class:"grab-footer"},button("Keep",()=>{scene="shelf";render();}),h("span",{class:"grow"}),button("Remove",()=>void perform("delete",{ids},false).then(result=>{if(result!==null){scene="shelf";render();}}),true)));
  }
  function groupFiles(){
    scene="group";el.dataset.scene=scene;let collection="";
    const input=field("Collection name",collection,value=>collection=value.slice(0,80));
    body.replaceChildren(head("Group references"),h("span",{class:"grab-hint",text:`Keep ${selected.size} selected files together.`}),input,
      h("div",{class:"grab-footer"},h("span",{class:"grow"}),button("Save",()=>void (async()=>{for(const id of [...selected])if(await perform("edit",{id,collection},false)===null)return;scene="shelf";render();message("Collection saved.");})(),true)));input.focus();
  }
  async function openReference(reference:GrabReference){
    if(reference.mime.startsWith("image/")){await detail(reference);return;}
    scene="detail";el.dataset.scene=scene;editorHeight=380;el.style.setProperty("--grab-detail-height","338px");State.notify();let label=reference.label,note=reference.note,collection=reference.collection;
    body.replaceChildren(head("File details"),h("div",{class:"grab-file-detail"},thumb(reference)),
      field("Reference name",label,value=>label=value.slice(0,160)),field("Reference note",note,value=>note=value.slice(0,2000)),field("Collection name",collection,value=>collection=value.slice(0,80)),
      h("div",{class:"grab-footer"},h("span",{class:"grab-hint",text:`${fileType(reference)} \u00b7 ${formatSize(reference.size)}`}),h("span",{class:"grow"}),button("Save",()=>void perform("edit",{id:reference.id,label,note,collection},false).then(result=>{if(result!==null){scene="shelf";render();message("File saved.");}}),true)));
  }
  async function detail(reference:GrabReference){
    scene="detail";el.dataset.scene=scene;State.notify();body.replaceChildren(head("Capture is ready"),h("div",{class:"grab-empty",text:"Opening reference…"}));
    if (!reference.mime.startsWith("image/")) return;
    const data=await perform<{image:string;annotations:unknown}>("preview",{id:reference.id},false);if(!data){scene="shelf";render();return;}
    let marks=validAnnotations(data.annotations),tool:AnnotationTool|"crop"="arrow",pending:Annotation|null=null,editing=false,zoom=0;
    let cropSelection:{x:number;y:number;endX:number;endY:number}|null=null;
    const history:{transform:ImageTransform;marks:Annotation[]}[]=[];
    const image=new Image();image.src=data.image;try{await image.decode();}catch{scene="shelf";render();message("This image could not be previewed.",true);return;}
    if(!active||scene!=="detail")return;
    let transform:ImageTransform=reference.transform?structuredClone(reference.transform):{width:image.naturalWidth,height:image.naturalHeight,crop:{x:0,y:0,width:1,height:1}};
    const canvas=h("canvas",{"aria-label":"Reference image with annotations"});canvas.width=transform.width;canvas.height=transform.height;
    const ctx=canvas.getContext("2d");if(!ctx)return;
    const draw=()=>{ctx.clearRect(0,0,canvas.width,canvas.height);const c=transform.crop;
      ctx.drawImage(image,c.x*image.naturalWidth,c.y*image.naturalHeight,c.width*image.naturalWidth,c.height*image.naturalHeight,0,0,canvas.width,canvas.height);
      paintAnnotations(ctx,canvas.width,canvas.height,pending?[...marks,pending]:marks);
      if(cropSelection){const x=Math.min(cropSelection.x,cropSelection.endX)*canvas.width,y=Math.min(cropSelection.y,cropSelection.endY)*canvas.height,
        w=Math.abs(cropSelection.endX-cropSelection.x)*canvas.width,hh=Math.abs(cropSelection.endY-cropSelection.y)*canvas.height;
        ctx.save();ctx.fillStyle="#0006";ctx.fillRect(0,0,canvas.width,y);ctx.fillRect(0,y+hh,canvas.width,canvas.height-y-hh);ctx.fillRect(0,y,x,hh);ctx.fillRect(x+w,y,canvas.width-x-w,hh);
        ctx.strokeStyle="#ffffff";ctx.lineWidth=Math.max(2,canvas.width/400);ctx.setLineDash([8,5]);ctx.strokeRect(x,y,w,hh);ctx.restore();
      }
    };draw();
    const scroller=h("div",{class:"grab-preview-scroll",tabindex:"0"},canvas);
    const annotationText=field("Annotation text","",()=>{});annotationText.classList.add("grab-annotation-text");annotationText.hidden=true;
    const tools=h("div",{class:"grab-tools",role:"group","aria-label":"Annotation tools",hidden:true});
    for(const id of ["arrow","rectangle","highlight","text","crop"] as const){const b=button(id[0].toUpperCase()+id.slice(1),()=>{tool=id;annotationText.hidden=id!=="text";resizeFields.hidden=true;message(id==="crop"?"Drag over the part you want to keep.":"");for(const button of tools.querySelectorAll("button[data-tool]"))button.setAttribute("aria-pressed",String((button as HTMLElement).dataset.tool===id));});b.dataset.tool=id;b.setAttribute("aria-pressed",String(id===tool));tools.append(b);}
    const dimensions=h("span",{class:"grab-hint",text:`${canvas.width} \u00d7 ${canvas.height}`});
    const width=h("input",{type:"number",min:1,max:16384,"aria-label":"Image width"}),height=h("input",{type:"number",min:1,max:16384,"aria-label":"Image height"});width.value=String(canvas.width);height.value=String(canvas.height);
    let keepShape=true;
    const shape=button("Keep shape",()=>{keepShape=!keepShape;shape.setAttribute("aria-pressed",String(keepShape));});shape.setAttribute("aria-pressed","true");
    width.addEventListener("input",()=>{if(keepShape)height.value=String(Math.max(1,Math.round(Number(width.value)*canvas.height/canvas.width)));});
    height.addEventListener("input",()=>{if(keepShape)width.value=String(Math.max(1,Math.round(Number(height.value)*canvas.width/canvas.height)));});
    const remember=()=>history.push({transform:structuredClone(transform),marks:structuredClone(marks)});
    const syncSize=()=>{canvas.width=transform.width;canvas.height=transform.height;width.value=String(canvas.width);height.value=String(canvas.height);dimensions.textContent=`${canvas.width} \u00d7 ${canvas.height}`;zoom=0;scroller.dataset.actual="false";canvas.style.width=canvas.style.height="";zoomLabel.querySelector("span")!.textContent="Fit";draw();};
    const syncEditorHeight=()=>{editorHeight=editing?(resizeFields.hidden?410:446):380;el.style.setProperty("--grab-detail-height",`${editorHeight-42}px`);State.notify();};
    const resizeFields=h("div",{class:"grab-resize",hidden:true},h("label",{text:"W"},width),h("label",{text:"H"},height),shape,button("Apply",()=>{
      const w=Number(width.value),hh=Number(height.value);if(!Number.isInteger(w)||!Number.isInteger(hh)||w<1||hh<1||w>16384||hh>16384||w*hh>64_000_000){message("Use dimensions up to 64 million pixels.",true);return;}
      remember();transform={...transform,width:w,height:hh};syncSize();resizeFields.hidden=true;syncEditorHeight();message("Size updated. Your original is safe.");
    },true));
    tools.append(button("Resize",()=>{resizeFields.hidden=!resizeFields.hidden;annotationText.hidden=true;tool="arrow";syncEditorHeight();}),button("Undo",()=>{const previous=history.pop();if(previous){transform=previous.transform;marks=previous.marks;syncSize();}else{marks.pop();draw();}}));
    const zoomLabel=button("Fit",()=>{zoom=0;scroller.dataset.actual="false";canvas.style.width=canvas.style.height="";zoomLabel.querySelector("span")!.textContent="Fit";});
    const setZoom=(factor:number)=>{const bounds=scroller.getBoundingClientRect();const base=zoom||Math.min(bounds.width/canvas.width,bounds.height/canvas.height,1);
      zoom=Math.max(.05,Math.min(4,base*factor));scroller.dataset.actual="true";canvas.style.width=`${canvas.width*zoom}px`;canvas.style.height=`${canvas.height*zoom}px`;zoomLabel.querySelector("span")!.textContent=`${Math.round(zoom*100)}%`;};
    const zoomControls=h("div",{class:"grab-zoom",role:"group","aria-label":"Image zoom"},glyphButton("Zoom out",ICONS.minus,()=>setZoom(.8)),zoomLabel,glyphButton("Zoom in",ICONS.plus,()=>setZoom(1.25)));
    scroller.addEventListener("wheel",event=>{if(!event.ctrlKey&&!event.metaKey)return;event.preventDefault();setZoom(event.deltaY>0?.8:1.25);},{passive:false});
    scroller.addEventListener("dblclick",()=>{if(!editing){zoom=1;scroller.dataset.actual="true";canvas.style.width=`${canvas.width}px`;canvas.style.height=`${canvas.height}px`;zoomLabel.querySelector("span")!.textContent="100%";}});
    const point=(event:PointerEvent)=>{const rect=canvas.getBoundingClientRect();return {x:Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width)),y:Math.max(0,Math.min(1,(event.clientY-rect.top)/rect.height))};};
    canvas.addEventListener("pointerdown",event=>{if(!editing||event.button!==0||marks.length>=100)return;const p=point(event);if(tool==="text"&&!annotationText.value.trim()){annotationText.focus();return;}
      canvas.setPointerCapture(event.pointerId);if(tool==="crop")cropSelection={...p,endX:p.x,endY:p.y};else pending={tool,...p,endX:p.x,endY:p.y,text:tool==="text"?annotationText.value.slice(0,500):undefined};draw();});
    canvas.addEventListener("pointermove",event=>{const selected=cropSelection||pending;if(selected){const p=point(event);selected.endX=p.x;selected.endY=p.y;draw();}});
    canvas.addEventListener("pointerup",()=>{
      if(cropSelection){const selected=cropSelection;cropSelection=null;const x=Math.min(selected.x,selected.endX),y=Math.min(selected.y,selected.endY),w=Math.abs(selected.endX-selected.x),hh=Math.abs(selected.endY-selected.y);
        if(w*canvas.width<2||hh*canvas.height<2){draw();return;}remember();const c=transform.crop;
        const clamp=(v:number)=>Math.max(0,Math.min(1,v));marks=marks.filter(m=>Math.max(m.x,m.endX)>=x&&Math.min(m.x,m.endX)<=x+w&&Math.max(m.y,m.endY)>=y&&Math.min(m.y,m.endY)<=y+hh)
          .map(m=>({...m,x:clamp((m.x-x)/w),endX:clamp((m.endX-x)/w),y:clamp((m.y-y)/hh),endY:clamp((m.endY-y)/hh)}));
        transform={width:Math.max(1,Math.round(canvas.width*w)),height:Math.max(1,Math.round(canvas.height*hh)),crop:{x:c.x+x*c.width,y:c.y+y*c.height,width:c.width*w,height:c.height*hh}};syncSize();message("Cropped. Your original is safe.");
      }else if(pending){remember();marks.push(pending);pending=null;draw();}
    });
    canvas.addEventListener("pointercancel",()=>{pending=null;cropSelection=null;draw();});
    let label=reference.label,note=reference.note,group=reference.collection;
    const labelField=field("Reference name",label,value=>label=value.slice(0,160)),noteField=field("Reference note",note,value=>note=value.slice(0,2000));
    const edit=button("Edit",()=>{editing=!editing;tools.hidden=!editing;if(!editing){resizeFields.hidden=true;annotationText.hidden=true;}edit.setAttribute("aria-pressed",String(editing));scroller.dataset.editing=String(editing);syncEditorHeight();},false,ICONS.edit);
    edit.setAttribute("aria-pressed","false");
    syncEditorHeight();
    body.replaceChildren(head("Capture is ready"),labelField,tools,resizeFields,annotationText,scroller,noteField,
      h("div",{class:"grab-footer"},edit,zoomControls,dimensions,h("span",{class:"grow"}),button("Save",()=>void (async()=>{
        if(await perform("edit",{id:reference.id,label,note,collection:group},false)===null)return;
        if(marks.length||reference.annotated||history.length){cropSelection=null;pending=null;draw();if(await perform("annotate",{id:reference.id,annotations:marks,transform,image:canvas.toDataURL("image/png")},false)===null)return;}
        scene="shelf";render();message("Saved to your shelf.");
      })(),true)));
  }
  function options(){
    const retention=h("select",{"aria-label":"Keep files"});
    for(const [value,label] of [[1,"1 day"],[7,"7 days"],[30,"30 days"],[0,"Until I remove them"]] as const)retention.append(h("option",{value,text:label}));retention.value=String(snapshot.retentionDays);
    body.append(head("Shelf options"),h("label",{class:"grab-option"},h("b",{text:"Keep files for"}),retention),
      field("Note to copy (optional)",instruction,value=>instruction=value.slice(0,12000)),h("span",{class:"grab-hint",text:"Files stay in Kumo. Your project folders stay clean."}),
      h("div",{class:"grab-footer"},button("Clean expired files",()=>void perform("clean_expired",{},false).then(result=>{if(result!==null){render();message("Expired files cleared.");}})),h("span",{class:"grow"}),button("Save",()=>void perform("preferences",{retentionDays:Number(retention.value)},false).then(result=>{if(result!==null){scene="shelf";render();message("Shelf options saved.");}}),true)));
  }
  async function captured(id:string){
    if(!active)return;++generation;scene="detail";el.dataset.scene=scene;State.notify();
    body.replaceChildren(head("Capture is ready"),h("div",{class:"grab-empty",text:"Opening your capture..."}));
    try {
      const data=await Bridge.grabRead();if(!active||!data)return;
      snapshot=data;const r=data.items.find(r=>r.id===id);
      if(r){Sound.play("pop");await detail(r);}else{scene="shelf";render();}
    }catch(error){scene="shelf";render();message(String(error),true);}
  }
  void onEvent<{id:string}>("grab-captured",value=>void captured(value.id)).then(stop=>active?stops.push(stop):stop());
  const localCapture=(event:Event)=>void captured((event as CustomEvent<string>).detail);
  document.addEventListener("grab-captured-preview",localCapture);stops.push(()=>document.removeEventListener("grab-captured-preview",localCapture));
  const clientError=(event:Event)=>message((event as CustomEvent<string>).detail,true);
  document.addEventListener("grab-client-error",clientError);stops.push(()=>document.removeEventListener("grab-client-error",clientError));
  void onEvent("grab-changed",()=>{if(visible&&!busy)void refresh();}).then(stop=>active?stops.push(stop):stop());
  void onEvent<string>("grab-error",error=>message(error,true)).then(stop=>active?stops.push(stop):stop());
  render();
  return {el,layout:()=>({...VIEW_LAYOUTS.grab,height:scene==="detail"?editorHeight:scene==="shelf"?shelfHeight:304}),sync(){},setVisible(value){if(visible===value)return;visible=value;if(value){shelfResize.observe(surface);void refresh();queueShelfMeasure();}else{shelfResize.disconnect();cancelAnimationFrame(shelfMeasure);shelfMeasure=0;}},destroy(){active=false;generation++;shelfResize.disconnect();cancelAnimationFrame(shelfMeasure);for(const stop of stops)stop();}};
}
