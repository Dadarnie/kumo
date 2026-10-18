// SPDX-License-Identifier: MIT
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';

// Include the Windows source/assets and the notices bundled by tauri.conf.json.
// Git blob IDs keep the fingerprint independent of Windows checkout line endings.
export const sourcePaths=['windows','LICENSE','LICENSE-ASSETS.md','THIRD_PARTY_NOTICES','legal/ASSETS.md','legal/NOTICE.md','legal/Coucou-MIT.txt','legal/legacy/MIMO-ASSETS-MIT.md'];

export function sourceSnapshot(root,reference){
 const entries=execFileSync('git',['ls-tree','-r','-z',reference,'--',...sourcePaths],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).split('\0').filter(Boolean).sort();
 if(!entries.length||entries.some(entry=>!/^100(?:644|755) blob [a-f0-9]{40}\t/.test(entry)))throw new Error('Expected regular, tracked application build inputs.');
 return {algorithm:'git-tree-sha256-v1',files:entries.length,sha256:createHash('sha256').update(entries.join('\0')+'\0').digest('hex')};
}
