// SPDX-License-Identifier: MIT
// Refresh the selected repository download after npm run pack.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {sourceSnapshot} from './source-snapshot.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
assert.equal(git('status','--porcelain'),'','Commit the source before building and recording the installer.');
const reference=git('rev-parse','HEAD');
const file='Mimo-Windows-setup.exe';
const input=new URL('../windows/release/'+file,import.meta.url);
const information=await stat(input);
assert(information.mtimeMs>=Number(git('show','-s','--format=%ct',reference))*1000,'Run npm run pack after the latest source commit.');
const bytes=await readFile(input);
assert.equal(bytes.subarray(0,2).toString(),'MZ');
assert.equal(bytes.subarray(bytes.readUInt32LE(60),bytes.readUInt32LE(60)+4).toString('hex'),'50450000');
const {version}=JSON.parse(await readFile(new URL('../windows/package.json',import.meta.url),'utf8'));
const signature=execFileSync('powershell',['-NoProfile','-Command',"(Get-AuthenticodeSignature -LiteralPath 'windows/release/Mimo-Windows-setup.exe').Status.ToString()"],{cwd:root,encoding:'utf8',windowsHide:true}).trim();
const sha256=createHash('sha256').update(bytes).digest('hex');
const record={file,version,platform:'windows-x86_64',sourceReference:reference,sourceSnapshot:sourceSnapshot(root,reference),builtAt:new Date(information.mtimeMs).toISOString(),bytes:bytes.length,sha256,signatureStatus:signature,note:'Built with npm run pack. The source fingerprint also identifies the equivalent source in a public repository with fresh history. No fresh installation was performed.'};
await writeFile(new URL('../downloads/'+file,import.meta.url),bytes);
await writeFile(new URL('../downloads/SHA256SUMS.txt',import.meta.url),sha256+'  '+file+'\n');
await writeFile(new URL('../downloads/build.json',import.meta.url),JSON.stringify(record,null,2)+'\n');
console.log(JSON.stringify(record,null,2));
