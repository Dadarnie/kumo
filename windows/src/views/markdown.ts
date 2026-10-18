// SPDX-License-Identifier: MIT
import { h } from "./dom";
import { Bridge, IS_TAURI } from "../core/bridge";

/** DOM-only formatting: replies are never interpreted as executable HTML. */
function inline(text: string): DocumentFragment {
  const result=document.createDocumentFragment();let cursor=0;
  for(const match of text.matchAll(/(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|~~[^~\n]+~~|\[[^\]\n]+\]\([^\s)]+\))/g)) {
    result.append(document.createTextNode(text.slice(cursor,match.index)));
    const token=match[0];let node:Node;
    if(token[0]==="`")node=h("code",{text:token.slice(1,-1)});
    else if(token.startsWith("**")||token.startsWith("__"))node=h("strong",{},inline(token.slice(2,-2)));
    else if(token.startsWith("~~"))node=h("del",{text:token.slice(2,-2)});
    else if(token[0]==="*")node=h("em",{text:token.slice(1,-1)});
    else { const parts=/^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)!;let url:URL|null=null;
      try{const parsed=new URL(parts[2]);if(["https:","http:"].includes(parsed.protocol))url=parsed;}catch{}
      if(url){const target=url.href;node=h("a",{href:target,target:"_blank",rel:"noopener noreferrer",onclick:(e:Event)=>{if(IS_TAURI){e.preventDefault();void Bridge.openUrl(target);}}},document.createTextNode(parts[1]));}else node=document.createTextNode(parts[1]);
    }
    result.append(node);cursor=match.index!+token.length;
  }
  result.append(document.createTextNode(text.slice(cursor)));return result;
}

export function renderMarkdown(text: string): HTMLElement {
  const root=h("div",{class:"markdown-content"});const lines=text.replace(/\r\n?/g,"\n").split("\n");let i=0;
  const cells=(line:string)=>line.trim().replace(/^\||\|$/g,"").split("|").map(v=>v.trim());
  while(i<lines.length){const line=lines[i];if(!line.trim()){i++;continue;}
    const fence=/^\s*(```+|~~~+)\s*([\w+-]*)/.exec(line);
    if(fence){const code:string[]=[];i++;while(i<lines.length&&!lines[i].trim().startsWith(fence[1]))code.push(lines[i++]);if(i<lines.length)i++;
      const source=code.join("\n");const copy:HTMLButtonElement=h("button",{type:"button",class:"markdown-copy",text:"Copy","aria-label":"Copy code",onclick:async()=>{try{await navigator.clipboard.writeText(source);copy.textContent="Copied";}catch{copy.textContent="Select to copy";}}});
      root.append(h("div",{class:"markdown-code"},h("div",{class:"markdown-code-head"},h("span",{text:fence[2]||"Code"}),copy),h("pre",{tabindex:"0"},h("code",{text:source}))));continue;}
    const heading=/^(#{1,6})\s+(.+)$/.exec(line);if(heading){const node=document.createElement(`h${Math.min(heading[1].length+1,6)}`);node.append(inline(heading[2].replace(/\s+#+$/,"")));root.append(node);i++;continue;}
    if(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)){root.append(h("hr"));i++;continue;}
    if(i+1<lines.length&&line.includes("|")&&/^\s*\|?\s*:?-{3,}/.test(lines[i+1])) {
      const columns=cells(line);const head=h("tr",{},...columns.map(v=>h("th",{},inline(v))));i+=2;const rows:HTMLElement[]=[];
      while(i<lines.length&&lines[i].includes("|")&&lines[i].trim())rows.push(h("tr",{},...cells(lines[i++]).slice(0,columns.length).map(v=>h("td",{},inline(v)))));
      root.append(h("div",{class:"markdown-table",tabindex:"0"},h("table",{},h("thead",{},head),h("tbody",{},...rows))));continue;
    }
    const bullet=/^\s*([-+*]|\d+[.)])\s+(.+)$/.exec(line);
    if(bullet){const ordered=/^\d/.test(bullet[1]);const list=document.createElement(ordered?"ol":"ul");if(ordered)list.setAttribute("start",String(parseInt(bullet[1],10)));
      while(i<lines.length){const item=/^\s*([-+*]|\d+[.)])\s+(.+)$/.exec(lines[i]);if(!item||/^\d/.test(item[1])!==ordered)break;const entry=h("li",{},inline(item[2]));i++;
        while(i<lines.length&&/^\s{2,}\S/.test(lines[i])&&!/^\s*([-+*]|\d+[.)])\s/.test(lines[i])){entry.append(h("br"),inline(lines[i++].trim()));}list.append(entry);}
      root.append(list);continue;
    }
    if(/^\s*>/.test(line)){const quote:string[]=[];while(i<lines.length&&/^\s*>/.test(lines[i]))quote.push(lines[i++].replace(/^\s*>\s?/,""));root.append(h("blockquote",{},renderMarkdown(quote.join("\n"))));continue;}
    const paragraph:string[]=[line];i++;while(i<lines.length&&lines[i].trim()&&!/^\s*(?:#{1,6}\s|```|~~~|>|[-+*]\s|\d+[.)]\s)/.test(lines[i])&&!(i+1<lines.length&&lines[i].includes("|")&&/^\s*\|?\s*:?-{3,}/.test(lines[i+1])))paragraph.push(lines[i++]);
    const p=h("p");paragraph.forEach((value,index)=>{if(index)p.append(h("br"));p.append(inline(value));});root.append(p);
  }
  return root;
}
