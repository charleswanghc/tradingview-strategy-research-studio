import test from 'node:test';
import assert from 'node:assert/strict';
import { shareUrl, parseSharedConversation, loadConversation } from '../dist/dashboard/conversation.js';

const url='https://chatgpt.com/share/00000000-0000-0000-0000-000000000001';
const message=(role,text)=>({author:{role},content:{parts:[text]}});
const data={title:'逆勢研究',current_node:'b',mapping:{a:{parent:null,message:message('user','用 5 分 K 測試逆勢')},b:{parent:'a',message:message('assistant','```pine\n//@version=6\nstrategy("Test")\n```')},other:{parent:'a',message:message('assistant','棄用分支')}}};
const html=value=>`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({props:{pageProps:{serverResponse:{data:value}}}})}</script>`;
function flatten(value){
  const table=[];
  function add(v){const i=table.length;table.push(null);table[i]=Array.isArray(v)?v.map(add):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([key,child])=>[`_${add(key)}`,add(child)])):v;return i;}
  add(value);return table;
}

test('shared JSON selects the current branch and preserves Pine code in chronological order',()=>{
  const result=parseSharedConversation(html(data));assert.equal(result.title,'逆勢研究');assert.equal(result.messages,2);
  assert.match(result.text,/使用者：[\s\S]*5 分 K[\s\S]*ChatGPT：[\s\S]*\/\/@version=6/);assert.doesNotMatch(result.text,/棄用分支/);
});

test('React Router streamed loader data is parsed without evaluating scripts',()=>{
  const serialized=JSON.stringify(flatten({loaderData:{sharedConversation:{title:data.title,linear_conversation:[{message:message('user','問題')},{message:message('assistant','策略回答')}]}}}))+'\n';
  const midpoint=Math.floor(serialized.length/2);
  const page=`<script>globalThis.executable = true;self.__reactRouterContext.streamController.enqueue(${JSON.stringify(serialized.slice(0,midpoint))});self.__reactRouterContext.streamController.enqueue(${JSON.stringify(serialized.slice(midpoint))});</script>`;
  const result=parseSharedConversation(page);assert.equal(result.messages,2);assert.match(result.text,/策略回答/);assert.equal(globalThis.executable,undefined);
  assert.throws(()=>parseSharedConversation('<html>Sign in</html>'),/無法讀取/);
});

test('deferred stream frames and hidden assistant messages do not contaminate the transcript',()=>{
  const deferred=flatten({loaderData:{sharedConversation:{linear_conversation:[{message:message('user','基準問題')},{message:{...message('assistant','內部分析'),channel:'analysis'}},{message:{...message('assistant','工具命令'),recipient:'browser'}},{message:message('assistant','最後策略')}]}}});
  // Deferred tables use absolute indexes following the initial loader table.
  function shift(v){return typeof v==='number'&&v>=0?v+1:Array.isArray(v)?v.map(shift):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,child])=>[/^_\d+$/.test(k)?`_${Number(k.slice(1))+1}`:k,shift(child)])):v;}
  const serialized='[{}]\nP1:'+JSON.stringify(deferred.map(shift))+'\n';
  const result=parseSharedConversation(`<script>self.__reactRouterContext.streamController.enqueue(${JSON.stringify(serialized)});</script>`);
  assert.equal(result.messages,2);assert.match(result.text,/最後策略/);assert.doesNotMatch(result.text,/內部分析|工具命令/);
});

test('only public ChatGPT share URLs can make a request',async()=>{
  assert.equal(shareUrl(url+'?tracking=1#fragment'),url);
  assert.equal(shareUrl(url.replace('chatgpt.com','chat.openai.com')),url);
  let calls=0;const request=async()=>{calls++;throw new Error('must not fetch');};
  for(const invalid of ['http://127.0.0.1/share/1',url.replace('chatgpt.com','chatgpt.com.example.org'),url.replace('https://','https://user:password@'),url.replace('/share/','/c/'),'chatgpt-conversation://private',url.replace('chatgpt.com','chatgpt.com:8443')]){
    await assert.rejects(()=>loadConversation({conversationText:'',conversationUrl:invalid},undefined,request));
  }
  assert.equal(calls,0);
});

test('URL fetch enforces response validity, redirect targets and size limits',async()=>{
  let options;
  const result=await loadConversation({conversationText:'',conversationUrl:url},undefined,async(target,opts)=>{assert.equal(target,url);options=opts;return new Response(html(data),{headers:{'Content-Type':'text/html; charset=utf-8'}});});
  assert.equal(result.url,url);assert.equal(options.redirect,'manual');assert.equal(options.headers.Authorization,undefined);
  await assert.rejects(()=>loadConversation({conversationText:'',conversationUrl:url},undefined,async()=>new Response('',{status:302,headers:{Location:'http://127.0.0.1/secret'}})),/只支援/);
  await assert.rejects(()=>loadConversation({conversationText:'',conversationUrl:url},undefined,async()=>new Response('',{status:404})),/HTTP 404/);
  await assert.rejects(()=>loadConversation({conversationText:'',conversationUrl:url},undefined,async()=>new Response('{}',{headers:{'Content-Type':'application/json'}})),/沒有回傳對話/);
  await assert.rejects(()=>loadConversation({conversationText:'',conversationUrl:url},undefined,async()=>new Response('x'.repeat(5*1024*1024+1),{headers:{'Content-Type':'text/html'}})),/大小限制/);
});

test('pasted text overrides inaccessible URLs and oversized transcripts are never silently truncated',async()=>{
  const result=await loadConversation({conversationText:' 使用者：策略需求 ',conversationUrl:'https://chatgpt.com/c/private'},undefined,async()=>{throw new Error('must not fetch');});
  assert.equal(result.text,' 使用者：策略需求 ');assert.match(result.url,/\/c\//);
  await assert.rejects(()=>loadConversation({conversationText:'x'.repeat(120001),conversationUrl:''}),/120,000/);
  assert.throws(()=>parseSharedConversation(html({linear_conversation:[{message:message('user','x'.repeat(120001))}]})),/120,000/);
});
