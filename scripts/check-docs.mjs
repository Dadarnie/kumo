// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,stat,access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {sourceSnapshot} from './source-snapshot.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const files=[...new Set(execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean))];
const existing=[];
for(const file of files)try{if((await stat(path.join(root,file))).isFile())existing.push(file);}catch{}
const publicFiles=new Set(existing.map(file=>file.replaceAll('\\','/')));
const errors=[];
for(const file of existing.filter(file=>/\.(md|html)$/.test(file))){
 const original=await readFile(path.join(root,file),'utf8');
 const content=original.replace(/^(?:```|~~~)[\s\S]*?^(?:```|~~~).*$/gm,'').replace(/`[^`\n]*`/g,'');
 const links=[...content.matchAll(/!?\[[^\]\n]*\]\(([^)\n]+)\)|(?:href|src)=["']([^"']+)["']/g)];
 for(const match of links){
  const target=(match[1]??match[2]).split(' "')[0].trim().replace(/^<|>$/g,'');
  if(/^[a-z][a-z\d+.-]*:/i.test(target)||target.startsWith('/')||target.startsWith('#'))continue;
  const relative=decodeURIComponent(target.split(/[?#]/)[0]);if(!relative)continue;
  const resolved=path.resolve(root,path.dirname(file),relative);
  if(!resolved.toLowerCase().startsWith(root.toLowerCase())){errors.push(`${file}: link leaves repository: ${target}`);continue;}
  try{
   await access(resolved);
   const destination=path.relative(root,resolved).split(path.sep).join('/');
   if(!publicFiles.has(destination)&&![...publicFiles].some(file=>file.startsWith(destination+'/')))errors.push(`${file}: local-only link target: ${target}`);
  }catch{errors.push(`${file}: missing link: ${target}`);}
 }
}
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
for(const file of ['LICENSE','THIRD_PARTY_NOTICES','legal/Coucou-MIT.txt','windows/src/assets/fonts/FiraCode-LICENSE.txt'])await access(path.join(root,file));
const previews=JSON.parse(await readFile(path.join(root,'docs/media/previews.json'),'utf8'));
for(const item of previews.clips){
 const bytes=await readFile(path.join(root,'docs/media',item.file));
 assert.equal(sha(bytes),item.sha256,`Stale GIF: ${item.file}`);
 assert.match(bytes.subarray(0,6).toString(),/^GIF8[79]a$/);
 assert.equal(bytes.readUInt16LE(6),item.width);assert.equal(bytes.readUInt16LE(8),item.height);
}
const screenshots=JSON.parse(await readFile(path.join(root,'docs/media/screenshots/captures.json'),'utf8'));
assert.deepEqual(screenshots.captures.map(item=>item.file).sort(),['settings.png','shelf.png']);
for(const item of screenshots.captures){
 const bytes=await readFile(path.join(root,'docs/media/screenshots',item.file));
 assert.equal(sha(bytes),item.sha256,`Changed screenshot: ${item.file}`);
 assert.equal(bytes.length,item.bytes);
 assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
 assert.equal(bytes.readUInt32BE(16),item.width);assert.equal(bytes.readUInt32BE(20),item.height);
}
for(const [file,hash] of Object.entries(screenshots.sources)){
 assert.equal(sha((await readFile(path.join(root,file),'utf8')).replaceAll('\r\n','\n')),hash,`Screenshot source changed: ${file}`);
}
const agents=JSON.parse(await readFile(path.join(root,'docs/media/agents/sources.json'),'utf8'));
assert.equal(agents.icons.length,9);
for(const item of agents.icons){
 assert.equal(sha(await readFile(path.join(root,'docs/media/agents',item.mark))),item.sha256,`Changed agent mark: ${item.id}`);
 assert.equal(sha(await readFile(path.join(root,'docs/media/agents',item.badge.file))),item.badge.sha256,`Stale agent badge: ${item.id}`);
}
const build=JSON.parse(await readFile(path.join(root,'downloads/build.json'),'utf8'));
const installer=await readFile(path.join(root,'downloads',build.file));
assert.equal(installer.subarray(0,2).toString(),'MZ');assert.equal(installer.length,build.bytes);assert.equal(sha(installer),build.sha256);
assert((await readFile(path.join(root,'downloads/SHA256SUMS.txt'),'utf8')).startsWith(build.sha256+'  '+build.file));
const packageJson=JSON.parse(await readFile(path.join(root,'windows/package.json'),'utf8'));
assert.equal(build.version,packageJson.version);
assert.match(build.sourceReference,/^[a-f0-9]{40}$/);
if(build.sourceSnapshot){
 const initialCommits=execFileSync('git',['rev-list','--max-parents=0','HEAD'],{cwd:root,encoding:'utf8'}).trim().split('\n');
 const references=[...new Set([build.sourceReference,'HEAD',...initialCommits])];
 assert(references.some(reference=>{
  try{const snapshot=sourceSnapshot(root,reference);return snapshot.algorithm===build.sourceSnapshot.algorithm&&snapshot.files===build.sourceSnapshot.files&&snapshot.sha256===build.sourceSnapshot.sha256;}catch{return false;}
 }),'The installer build inputs must match its source commit or the clean public snapshot.');
}else{
 execFileSync('git',['cat-file','-e',`${build.sourceReference}:windows/package.json`],{cwd:root});
}
console.log(JSON.stringify({documents:existing.filter(file=>/\.(md|html)$/.test(file)).length,screenshots:screenshots.captures.length,gifs:previews.clips.length,installerBytes:installer.length,installerSha256:build.sha256,errors},null,2));
if(errors.length)process.exitCode=1;
