// Test-only local provider and HTTP fixture. Never loaded by the product manifest.
import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function fixture(pi: ExtensionAPI) {
  const log=(value:unknown)=>appendFileSync(process.env.COMPACT_TEST_LOG!,JSON.stringify(value)+"\n");
  globalThis.fetch=async(input,init)=>{
    if(String(input)!=="https://api.typesafe.ai/v1/systemone")throw new Error("Unexpected network request in isolated smoke test");
    log({event:"jev",body:JSON.parse(String(init?.body))});
    return new Response(JSON.stringify({model:"jev-fixture",usage:{input_tokens:2000,output_tokens:60},answers:{
      done:{type:"choice",choice:"finished",probabilities:{finished:0.995,not_finished:0.004,unclear:0.001},confidence:0.99},
      shape:{type:"choice",choice:"hands_on",probabilities:{hands_on:0.99,coordinating:0.008,unclear:0.002},confidence:0.98},
    }}));
  };
  pi.registerProvider("compact-fixture",{baseUrl:"http://127.0.0.1:1",apiKey:"fixture-not-a-secret",api:"compact-fixture",models:[{id:"local",name:"Local test provider",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:272000,maxTokens:1000}],streamSimple:(model)=>{
    const stream=createAssistantMessageEventStream();
    const message={role:"assistant" as const,api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),stopReason:"stop" as const,content:[{type:"text" as const,text:"The report is saved. This phase is complete; next work can read the artifact."}],usage:{input:45000,output:20,cacheRead:0,cacheWrite:0,totalTokens:45020,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
    queueMicrotask(()=>{stream.push({type:"start",partial:message});stream.push({type:"text_start",contentIndex:0,partial:message});stream.push({type:"text_delta",contentIndex:0,delta:message.content[0].text,partial:message});stream.push({type:"text_end",contentIndex:0,content:message.content[0].text,partial:message});stream.push({type:"done",reason:"stop",message});stream.end();});
    return stream;
  }});
  pi.on("session_start",(_event,ctx)=>log({event:"start",mode:ctx.mode,version:"native"}));
  pi.on("agent_settled",(_event,ctx)=>log({event:"settled",idle:ctx.isIdle(),tokens:ctx.getContextUsage()?.tokens}));
  pi.on("session_before_compact",(event)=>({compaction:{summary:"Deterministic native-compaction smoke fixture. Report saved; next read artifact.",firstKeptEntryId:event.preparation.firstKeptEntryId,tokensBefore:event.preparation.tokensBefore}}));
  pi.on("session_compact",(_event,ctx)=>log({event:"compacted",tokens:ctx.getContextUsage()?.tokens}));
}
