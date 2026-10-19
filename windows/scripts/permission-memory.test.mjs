// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {loadSource} from './ts-test-loader.mjs';
const {permissionInputKey,rememberPermission,permissionRemembered,forgetPermissions}=await import(await loadSource('../src/core/permission-memory.ts'));
test('Always remembers the exact tool input only for its owning live session and workspace',()=>{
  const request={provider:'codex',sessionId:'alpha',cwd:'C:/work/alpha',tool:'Bash',inputKey:permissionInputKey({command:'npm test',description:'Run tests'})};
  forgetPermissions();rememberPermission(request);
  assert(permissionRemembered({...request,inputKey:permissionInputKey({description:'A new explanation',command:'npm test'})}));
  for(const other of [{provider:'claude'},{sessionId:'beta'},{cwd:'C:/work/beta'},{tool:'PowerShell'},{inputKey:permissionInputKey({command:'npm test && npm publish'})},{inputKey:permissionInputKey({command:'npm test',directory:'other'})}])assert(!permissionRemembered({...request,...other}));
  assert.equal(permissionInputKey({b:{y:2,x:1},a:[1,2]}),permissionInputKey({a:[1,2],b:{x:1,y:2}}));
  forgetPermissions('codex','alpha');assert(!permissionRemembered(request));
});
test('permission memory rejects questions, incomplete identities, and oversized inputs',()=>{
  forgetPermissions();
  const request={provider:'claude',sessionId:'alpha',cwd:'C:/alpha',tool:'Edit',inputKey:permissionInputKey({file_path:'a.ts',new_string:'one'})};
  rememberPermission(request);
  assert(!permissionRemembered({...request,inputKey:permissionInputKey({file_path:'a.ts',new_string:'two'})}));
  for(const missing of [{questions:[{question:'Choose?'}]},{sessionId:''},{cwd:''},{inputKey:undefined}]){rememberPermission({...request,...missing});assert(!permissionRemembered({...request,...missing}));}
  assert.equal(permissionInputKey({description:'No action'}),undefined);
  assert.equal(permissionInputKey({command:'x'.repeat(13000)}),undefined);
  forgetPermissions();assert(!permissionRemembered(request));
});
