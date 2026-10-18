// SPDX-License-Identifier: MIT
// Export reviewed tracked files only. The ZIP contains no Git history.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {sourceSnapshot} from './source-snapshot.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const options=process.argv.slice(2);
const value=name=>{const index=options.indexOf(name);return index<0?null:options[index+1];};
const ref=value('--ref')??'main';
const output=value('--out');
assert(output&&/^[a-z\d][a-z\d/_.-]*$/i.test(ref),'Use --ref main --out C:\\projects\\mimo-public.zip');
const destination=path.resolve(output);
assert.equal(path.extname(destination).toLowerCase(),'.zip','Choose a ZIP output path.');
assert(!existsSync(destination),'Choose a new output path; existing exports are never overwritten.');
const git=(...args)=>execFileSync('git',args,{cwd:root,maxBuffer:128*1024*1024});
const reference=git('rev-parse','--verify',ref+'^{commit}').toString().trim();
assert.equal(reference,git('rev-parse','HEAD').toString().trim(),'Switch to the branch you want to export first.');
assert.equal(git('status','--porcelain').toString().trim(),'','Commit the reviewed files before exporting.');
const files=git('ls-tree','-r','--name-only',reference).toString().trimEnd().split('\n');
const forbidden=/^(?:_prive|product-launch|\.agents|\.codex|\.claude|skills|references?|screenshots|posters)\/|^windows\/(?:node_modules|target|dist|release|promotion|verification|screenshots|video-reference)\//i;
assert(!files.some(file=>forbidden.test(file)),'Private or generated material is tracked; review it before exporting.');
assert(!files.some(file=>/^licenses\//i.test(file)),'Keep supporting notices in legal/ to avoid extra license tabs.');
assert.deepEqual(files.filter(file=>!file.includes('/')&&/^(?:(?:un)?licen[sc]e|copying|copyright|ofl|patents)(?:$|[-_.])/i.test(file)).sort(),['LICENSE','LICENSE-ASSETS.md']);
const build=JSON.parse(git('show',reference+':downloads/build.json'));
assert.deepEqual(sourceSnapshot(root,reference),build.sourceSnapshot,'Rebuild and refresh the installer after changing application inputs.');
const installer=git('show',reference+':downloads/'+build.file);
assert.equal(createHash('sha256').update(installer).digest('hex'),build.sha256);
assert.equal(installer.length,build.bytes);
await mkdir(path.dirname(destination),{recursive:true});
git('archive','--format=zip','--output',destination,reference);
const zip=await readFile(destination);
console.log(JSON.stringify({file:destination,sourceReference:reference,files:files.length,bytes:zip.length,sha256:createHash('sha256').update(zip).digest('hex'),includesGitHistory:false},null,2));
