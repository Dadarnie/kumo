// SPDX-License-Identifier: MIT
export interface GrabReference {
  extension?: string;
  id:string;label:string;note:string;collection:string;createdAt:number;mime:string;
  width:number;height:number;size:number;source:string;duplicateOf:string|null;
  annotations:Annotation[]|null;annotated:boolean;
  transform?:ImageTransform|null;
}
export interface ImageTransform {width:number;height:number;crop:{x:number;y:number;width:number;height:number}}
export interface GrabSnapshot {
  items:GrabReference[];retentionDays:number;detached:boolean;
}
export type AnnotationTool="arrow"|"rectangle"|"highlight"|"text";
export interface Annotation {tool:AnnotationTool;x:number;y:number;endX:number;endY:number;text?:string}
export function reorderedReferences(ids:string[],source:string,target:string):string[] {
  const order=ids.filter(id=>id!==source),at=order.indexOf(target);
  if (!ids.includes(source)||at<0) return ids;
  order.splice(at,0,source);return order;
}
export function validAnnotations(value:unknown):Annotation[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0,100).filter((mark):mark is Annotation=>!!mark&&["arrow","rectangle","highlight","text"].includes(mark.tool)
    &&[mark.x,mark.y,mark.endX,mark.endY].every(v=>typeof v==="number"&&Number.isFinite(v)&&v>=0&&v<=1))
    .map(mark=>({...mark,text:mark.text?.slice(0,500)}));
}
export function paintAnnotations(ctx:CanvasRenderingContext2D,w:number,h:number,marks:Annotation[]):void {
  for (const mark of validAnnotations(marks)) {
    const x=mark.x*w,y=mark.y*h,ex=mark.endX*w,ey=mark.endY*h;
    ctx.save();ctx.strokeStyle="#75c7ff";ctx.fillStyle="#75c7ff";ctx.lineWidth=Math.max(2,w/350);ctx.lineJoin=ctx.lineCap="round";
    if (mark.tool==="highlight") {ctx.globalAlpha=.28;ctx.fillRect(Math.min(x,ex),Math.min(y,ey),Math.abs(ex-x),Math.abs(ey-y));}
    else if (mark.tool==="rectangle") ctx.strokeRect(Math.min(x,ex),Math.min(y,ey),Math.abs(ex-x),Math.abs(ey-y));
    else if (mark.tool==="text") {ctx.font=`600 ${Math.max(16,w/50)}px 'Segoe UI',sans-serif`;ctx.lineWidth=3;ctx.strokeStyle="#111318";ctx.strokeText(mark.text??"",x,y);ctx.fillText(mark.text??"",x,y);}
    else {ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(ex,ey);ctx.stroke();const a=Math.atan2(ey-y,ex-x),size=Math.max(10,w/70);
      ctx.beginPath();ctx.moveTo(ex,ey);ctx.lineTo(ex-size*Math.cos(a-.45),ey-size*Math.sin(a-.45));ctx.lineTo(ex-size*Math.cos(a+.45),ey-size*Math.sin(a+.45));ctx.closePath();ctx.fill();}
    ctx.restore();
  }
}
