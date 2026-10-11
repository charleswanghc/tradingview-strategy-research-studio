import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

async function dpapi(value: string, decrypt: boolean): Promise<string> {
  const op = decrypt ? 'Unprotect' : 'Protect';
  const script = `Add-Type -AssemblyName System.Security; $payload = [Console]::In.ReadToEnd(); $bytes = [Convert]::FromBase64String($payload); $output = [System.Security.Cryptography.ProtectedData]::${op}($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Write([Convert]::ToBase64String($output))`;
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile','-NonInteractive','-Command',script], {windowsHide:true});
    let result=''; child.stdout.on('data', d=>result+=d); child.stdin.on('error',()=>{});
    child.on('error',()=>reject(new Error('Windows 憑證加密服務無法啟動。')));
    child.on('close', code=>code===0 ? resolve(result.trim()) : reject(new Error('Windows 憑證加密／解密失敗。')));
    child.stdin.end(value);
  });
}
export class Credentials {
  private key = '';
  model = '';
  constructor(private directory: string) {}
  async load() {
    try {
      const stored = JSON.parse(await readFile(join(this.directory,'ai.json'),'utf8'));
      this.model = stored.model;
      if (stored.protectedKey && process.platform === 'win32') this.key = Buffer.from(await dpapi(stored.protectedKey,true),'base64').toString('utf8');
    } catch(e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  status() { return {provider:'openai',model:this.model,hasKey:!!this.key, storage:process.platform==='win32'?'Windows DPAPI（目前使用者）':'僅本次記憶體'}; }
  getKey() { if (!this.key) throw new Error('請先在 AI 設定輸入 API Key。'); return this.key; }
  async save(model: string, key?: string) {
    if (!/^[\w.:-]{1,100}$/.test(model)) throw new Error('請輸入有效的模型 ID。');
    if (key !== undefined && (key.length < 10 || key.length > 500 || /\s/.test(key))) throw new Error('API Key 格式不正確。');
    const next = key || this.key;
    await mkdir(this.directory,{recursive:true});
    const protectedKey = next && process.platform==='win32' ? await dpapi(Buffer.from(next).toString('base64'),false) : undefined;
    await writeFile(join(this.directory,'ai.json'),JSON.stringify({model,protectedKey}),{mode:0o600});
    this.key=next; this.model=model; return this.status();
  }
  async clear() { this.key=''; await unlink(join(this.directory,'ai.json')).catch(e=>{if(e.code!=='ENOENT')throw e;}); this.model=''; }
  redact(message: string) { return this.key ? message.replaceAll(this.key,'[REDACTED]') : message; }
}
