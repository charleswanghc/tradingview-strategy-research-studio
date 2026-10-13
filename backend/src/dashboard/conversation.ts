const MAX_TEXT = 120000;
const MAX_PAGE_BYTES = 5 * 1024 * 1024;
export interface Conversation { text:string; url?:string; title?:string; messages?:number }

export function shareUrl(value:string):string {
  let url:URL;
  try { url=new URL(value.trim()); } catch { throw new Error('請貼上完整的 ChatGPT 分享網址，或直接貼上對話文字。'); }
  if(url.protocol!=='https:' || !['chatgpt.com','chat.openai.com'].includes(url.hostname) || url.port || url.username || url.password)
    throw new Error('對話網址只支援 https://chatgpt.com/share/… 公開分享連結。');
  if(!/^\/share\/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\/?$/i.test(url.pathname))
    throw new Error('這不是 ChatGPT 分享網址。私人 /c/ 對話需要登入；請在 ChatGPT 按「分享」取得 /share/ 網址，或直接貼上對話文字。');
  return `https://chatgpt.com${url.pathname.replace(/\/$/,'')}`;
}

function checkedText(text:string):string {
  if(!text.trim())throw new Error('對話沒有可讀取的文字。');
  if(text.length>MAX_TEXT)throw new Error('對話超過 120,000 字元；請貼上與這次策略研究相關的部分。');
  return text;
}

// React Router serializes loader data as an indexed table. Decode data only;
// scripts from the shared page are never evaluated.
function unflatten(table:unknown[],start=0):unknown {
  const seen=new Map<number,unknown>();
  function decode(index:unknown,depth=0):any {
    if(typeof index!=='number')return index;
    if(index<0)return undefined;
    if(!Number.isInteger(index) || index>=table.length || depth>200)throw new Error('Invalid shared data reference.');
    if(seen.has(index))return seen.get(index);
    const value=table[index];
    if(value===null || typeof value!=='object'){seen.set(index,value);return value;}
    const out:any=Array.isArray(value)?[]:Object.create(null);seen.set(index,out);
    if(Array.isArray(value)){
      // Tagged records are not conversation messages; retain their payload only.
      for(const item of value)out.push(decode(item,depth+1));
    }else for(const [key,ref]of Object.entries(value)){
      const name=/^_\d+$/.test(key)?decode(Number(key.slice(1)),depth+1):key;
      if(typeof name==='string')out[name]=decode(ref,depth+1);
    }
    return out;
  }
  return decode(start);
}

function conversationData(root:unknown):Conversation|undefined {
  const seen=new Set<object>();
  function visit(value:any,depth=0):Conversation|undefined {
    if(!value || typeof value!=='object' || seen.has(value) || depth>200)return;
    seen.add(value);
    let nodes:any[]|undefined;
    if(value.mapping && typeof value.mapping==='object'){
      const mapping=value.mapping;
      if(value.current_node && mapping[value.current_node]){
        nodes=[];let node=mapping[value.current_node];const path=new Set<object>();
        while(node && !path.has(node)){path.add(node);nodes.unshift(node);node=mapping[node.parent];}
      }else nodes=Object.values(mapping);
    }else if(Array.isArray(value.linear_conversation))nodes=value.linear_conversation;
    if(nodes){
      const messages=nodes.flatMap(node=>{
        const message=node.message || node,role=message.author?.role;
        if(!['user','assistant'].includes(role) || message.metadata?.is_visually_hidden_from_conversation || message.channel==='analysis' || message.recipient && message.recipient!=='all')return [];
        const parts=message.content?.parts;
        const text=Array.isArray(parts)?parts.filter((p:unknown)=>typeof p==='string').join('\n'):message.content?.text;
        return typeof text==='string' && text.trim()?[`${role==='user'?'使用者':'ChatGPT'}：\n${text.trim()}`]:[];
      });
      if(messages.length)return {text:checkedText(messages.join('\n\n')),messages:messages.length,title:typeof value.title==='string'?value.title:undefined};
    }
    for(const child of Object.values(value)){const found=visit(child,depth+1);if(found)return found;}
  }
  return visit(root);
}

export function parseSharedConversation(html:string):Conversation {
  if(Buffer.byteLength(html)>MAX_PAGE_BYTES)throw new Error('ChatGPT 分享頁面超過大小限制。');
  const payloads:unknown[]=[];
  for(const match of html.matchAll(/<script\b[^>]*\btype=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi)){
    try{payloads.push(JSON.parse(match[1]));}catch{/* Unrelated JSON scripts are ignored. */}
  }
  let stream='';
  for(const match of html.matchAll(/streamController\.enqueue\(\s*("(?:[^"\\]|\\.)*")\s*\)/g)){
    try{stream+=JSON.parse(match[1]);}catch{/* Never evaluate embedded JavaScript. */}
  }
  let table:unknown[]=[];
  for(const line of stream.split('\n')){
    try{
      const frame=/^P\d+:(.*)$/.exec(line);
      const value=JSON.parse(frame?frame[1]:line);
      if(Array.isArray(value)){
        const start=table.length;for(const item of value)table.push(item);
        payloads.push(unflatten(table,start));
      }
    }catch{/* Other streamed frames are not loader data. */}
  }
  for(const payload of payloads){const result=conversationData(payload);if(result)return result;}
  throw new Error('無法讀取分享頁面的對話；連結可能已失效、需要登入或頁面格式已變更。請直接貼上對話文字後開始研究。');
}

export async function loadConversation(input:{conversationText:string;conversationUrl:string},signal?:AbortSignal,request:typeof fetch=fetch):Promise<Conversation> {
  // Pasted text is an explicit fallback/override, so an inaccessible URL never blocks it.
  if(input.conversationText.trim())return {text:checkedText(input.conversationText),url:input.conversationUrl.trim()||undefined};
  let url=shareUrl(input.conversationUrl);
  const timeout=AbortSignal.timeout(30000),combined=signal?AbortSignal.any([signal,timeout]):timeout;
  for(let redirects=0;redirects<4;redirects++){
    let response:Response;
    try{response=await request(url,{redirect:'manual',signal:combined,headers:{Accept:'text/html'}});}
    catch{if(signal?.aborted)throw new Error('使用者停止研究。');throw new Error('ChatGPT 分享網址讀取失敗或逾時；請改貼對話文字。');}
    if([301,302,303,307,308].includes(response.status)){
      await response.body?.cancel();
      const location=response.headers.get('location');if(!location)break;
      url=shareUrl(new URL(location,url).href);continue;
    }
    if(!response.ok){await response.body?.cancel();throw new Error(`ChatGPT 分享網址無法讀取（HTTP ${response.status}）；請確認分享連結仍有效，或改貼對話文字。`);}
    if(!response.headers.get('content-type')?.includes('text/html')){await response.body?.cancel();throw new Error('分享網址沒有回傳對話頁面；請改貼對話文字。');}
    const reader=response.body?.getReader();if(!reader)break;
    const chunks:Uint8Array[]=[];let size=0;
    try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>MAX_PAGE_BYTES)throw new Error('ChatGPT 分享頁面超過大小限制。');chunks.push(value);}}
    finally{await reader.cancel();reader.releaseLock();}
    return {...parseSharedConversation(Buffer.concat(chunks).toString('utf8')),url};
  }
  throw new Error('ChatGPT 分享網址重新導向過多或沒有內容；請改貼對話文字。');
}
