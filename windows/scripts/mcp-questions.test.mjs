// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mimoMcp} from './mcp-client.mjs';

test('Mimo MCP uses clean stdio, negotiates tools and rejects invalid question calls', {timeout:15000},async()=>{
  const client=mimoMcp('codex');
  try {
    assert.equal((await client.request('tools/list')).error.code,-32002);
    const initialized=await client.initialize('2025-06-18');
    assert.equal(initialized.protocolVersion,'2025-06-18');
    assert.deepEqual(initialized.capabilities,{tools:{listChanged:false}});
    assert.match(initialized.instructions,/explicit answers/);
    const tools=(await client.request('tools/list')).result.tools;
    assert.equal(tools.length,1);assert.equal(tools[0].name,'ask_user');
    assert.deepEqual(tools[0].inputSchema.required,['questions']);
    assert.equal((await client.request('tools/call',{name:'missing',arguments:{}})).error.code,-32602);
    for(const args of [{questions:[]},{questions:[{question:'Which check?',options:[]}],answers:{'Which check?':'Prefilled'}},
      {cwd:'relative/path',questions:[{question:'Which check?',options:[]}]}]) {
      assert.equal((await client.request('tools/call',{name:'ask_user',arguments:args})).error.code,-32602);
    }
    assert.equal((await client.request('unknown')).error.code,-32601);
    assert.deepEqual((await client.request('ping')).result,{});
    assert.deepEqual(client.errors,[]);
  } finally {await client.close();}
});
