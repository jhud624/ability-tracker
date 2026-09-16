import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createCoachLoopMcpServer } from '../mcp/coach-loop-tools.mjs';

test('write receipts distinguish verified, concurrent change, read failure, and actual write failure', async () => {
  let mode = 'ok'; let writes = 0;
  const memory = {memory_id:'memory-x',key:'x',version:1,text:'Short warmup'};
  const plan = {plan_id:'p',week_start_date:'2026-09-14',goals:['Easy week'],activities:[{activity_id:'r',date:'2026-09-20',title:'Run',type:'run',target:{distance_miles:4},subtasks:[]}]};
  const api = http.createServer((req,res) => {
    res.setHeader('content-type','application/json');
    if (req.method !== 'GET') {
      writes++;
      if(mode === 'write-failure') { res.statusCode=500; res.end(JSON.stringify({error:'Storage unavailable'})); return; }
      res.end(JSON.stringify(req.url.includes('memories') ? {saved:[memory],coach_memories:[memory]} : {active_plan:plan}));
    } else if(mode === 'read-failure') { res.statusCode=503; res.end(JSON.stringify({error:'Read unavailable'})); }
    else res.end(JSON.stringify(req.url.includes('memories') ? {coach_memories:[{...memory,version:mode === 'changed' ? 2 : 1}]} : {...plan,plan_id: mode === 'changed' ? 'other' : 'p'}));
  });
  api.listen(0); await once(api,'listening');
  const server = createCoachLoopMcpServer({apiUrl:`http://127.0.0.1:${api.address().port}`});
  const client = new Client({name:'receipt-test',version:'1'});
  const [a,b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  try {
    for (const name of ['upsert_coaching_memories','import_weekly_plan','update_day_plan']) {
      const args = name === 'upsert_coaching_memories' ? {coach_memories:[{key:'x',kind:'preference',category:'exercise',text:'Short warmup'}]} : name === 'import_weekly_plan' ? {plan} : {date:'2026-09-20',activities:plan.activities};
      for(const [scenario,status] of [['ok','verified'],['changed','changed_after_save'],['read-failure','saved_verification_pending']]) {
        mode=scenario; const before=writes;
        const result=await client.callTool({name,arguments:args});
        assert.equal(JSON.parse(result.content[0].text).receipt.status,status);
        assert.equal(writes,before+1,'read-back never replays a write');
      }
      mode='write-failure';
      const result=await client.callTool({name,arguments:args});
      assert.equal(result.isError,true);
    }
  } finally { await client.close(); await server.close(); await new Promise(resolve=>api.close(resolve)); }
});
