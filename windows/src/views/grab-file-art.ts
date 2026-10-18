// SPDX-License-Identifier: MIT
import type {GrabReference} from "../core/grab";

export type FileKind="image"|"pdf"|"document"|"code"|"archive"|"audio"|"video"|"sheet"|"slides"|"font"|"file";
export function fileType(r:GrabReference):string {
  const types:Record<string,string>={"image/png":"PNG","image/jpeg":"JPG","image/webp":"WEBP","application/pdf":"PDF"};
  if(types[r.mime])return types[r.mime];
  const extension=(r.extension||r.label.split(".").slice(1).at(-1)||"").toUpperCase();
  return extension&&/^[A-Z0-9]{1,12}$/.test(extension)?extension:"FILE";
}
export function fileKind(r:GrabReference):FileKind {
  const type=fileType(r);
  if(r.mime.startsWith("image/")||/^(PNG|JPG|JPEG|WEBP|GIF|BMP|SVG|ICO|AVIF|HEIC)$/.test(type))return "image";
  if(type==="PDF")return "pdf";
  if(/^(ZIP|RAR|7Z|GZ|TAR|BZ2)$/.test(type))return "archive";
  if(r.mime.startsWith("audio/")||/^(MP3|WAV|FLAC|M4A|AAC|OGG)$/.test(type))return "audio";
  if(r.mime.startsWith("video/")||/^(MP4|MOV|WEBM|MKV|AVI)$/.test(type))return "video";
  if(/^(XLS|XLSX|CSV|ODS)$/.test(type))return "sheet";
  if(/^(PPT|PPTX|KEY|ODP)$/.test(type))return "slides";
  if(/^(TTF|OTF|WOFF|WOFF2)$/.test(type))return "font";
  if(/^(JS|TS|JSX|TSX|JSON|HTML|CSS|SCSS|RS|PY|GO|SH|YAML|YML|TOML|XML|SQL)$/.test(type))return "code";
  if(/^(TXT|MD|DOC|DOCX|RTF|ODT)$/.test(type))return "document";
  return "file";
}

/** A quiet folded file mark; the adjacent extension carries the format. */
export function fileArtwork(_kind:FileKind):SVGSVGElement {
  const art=document.createElementNS("http://www.w3.org/2000/svg","svg");
  art.setAttribute("viewBox","0 0 34 42");art.setAttribute("aria-hidden","true");art.classList.add("grab-file-art");
  art.innerHTML='<path d="M7 1h15l11 11v24a5 5 0 0 1-5 5H7a5 5 0 0 1-5-5V6a5 5 0 0 1 5-5Z" fill="currentColor"/><path d="M22 1v7a4 4 0 0 0 4 4h7Z" fill="#fff" opacity=".2"/>';
  return art;
}
