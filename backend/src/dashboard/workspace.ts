import { mkdir, readFile, writeFile, readdir, realpath, lstat } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute, basename } from 'node:path';
import { spawn } from 'node:child_process';

export const folders = ['strategies', 'versions', 'runs', 'analysis'] as const;
export class Workspace {
  root?: string;
  constructor(private configDirectory: string) {}
  async load() {
    try { const value = JSON.parse(await readFile(join(this.configDirectory, 'workspace.json'), 'utf8')); this.root = await realpath(value.root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  async initialize(parent: string, name = 'TradingViewResearch') {
    if (!isAbsolute(parent) || !/^[\p{L}\p{N}_ -]{1,80}$/u.test(name) || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(name)) throw new Error('請指定完整資料夾位置及有效的工作資料夾名稱。');
    const base = await realpath(parent);
    const root = join(base, name);
    await mkdir(root, {recursive:true});
    if ((await lstat(root)).isSymbolicLink() || await realpath(root) !== root) throw new Error('工作資料夾不能是連結。');
    for (const folder of folders) {
      const path = join(root, folder); await mkdir(path, {recursive:true});
      if ((await lstat(path)).isSymbolicLink() || await realpath(path) !== path) throw new Error('工作子資料夾不能是連結。');
    }
    const ignore = join(root, '.gitignore');
    try { await writeFile(ignore, '*\n!.gitignore\n', {flag:'wx'}); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    await writeFile(join(root, 'README.txt'), '策略來源放在 strategies；每版程式在 versions；原始回測在 runs；分析與比較在 analysis。\n本目錄可能含私人策略，請勿公開。\n', {flag:'wx'}).catch(e => {if (e.code !== 'EEXIST') throw e;});
    await mkdir(this.configDirectory, {recursive:true});
    await writeFile(join(this.configDirectory, 'workspace.json'), JSON.stringify({root}, null, 2));
    this.root = root; return this.paths();
  }
  paths() { return this.root ? {root:this.root, ...Object.fromEntries(folders.map(f => [f, join(this.root!, f)]))} : null; }
  async safePath(path: string) {
    if (!this.root) throw new Error('請先建立工作資料夾。');
    const target = resolve(this.root, path), rel = relative(this.root, target);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('路徑超出工作資料夾。');
    const actual = await realpath(target);
    const actualRel = relative(await realpath(this.root), actual);
    if (actualRel.startsWith('..') || isAbsolute(actualRel) || (await lstat(target)).isSymbolicLink()) throw new Error('拒絕工作資料夾外的連結。');
    return target;
  }
  async files() {
    if (!this.root) return [];
    const dir = await this.safePath('strategies');
    return (await readdir(dir, {withFileTypes:true})).filter(f => f.isFile() && /\.(pine|txt|eld|pla)$/i.test(f.name)).map(f => f.name);
  }
  async source(name: string) {
    if (basename(name) !== name || !/\.(pine|txt)$/i.test(name)) throw new Error('請使用 strategies 下的 .pine 或文字格式 .txt；二進位 ELD/PLA 請先從 MultiCharts 匯出文字。');
    const path = await this.safePath(join('strategies', name));
    if ((await lstat(path)).size > 200000) throw new Error('策略檔案不能超過 200 KB。');
    try { return new TextDecoder('utf-8',{fatal:true}).decode(await readFile(path)); }
    catch { throw new Error('策略文字必須使用 UTF-8 編碼；請先另存為 UTF-8。'); }
  }
  async import(name: string, source: string) {
    if (basename(name) !== name || !/\.(pine|txt)$/i.test(name) || Buffer.byteLength(source) > 200000) throw new Error('只能匯入 200 KB 以下的 .pine／.txt。');
    const dir = await this.safePath('strategies');
    await writeFile(join(dir, name), source, {flag:'wx'}); return this.files();
  }
}

export async function pickDirectory(): Promise<string> {
  if (process.platform !== 'win32') throw new Error('此系統請直接填寫完整資料夾路徑。');
  // Fixed script; no user input is interpolated into PowerShell.
  return new Promise((resolve, reject) => {
    const script = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Windows.Forms; $picker = New-Object System.Windows.Forms.FolderBrowserDialog; $picker.Description = "Select TradingView research location"; if ($picker.ShowDialog() -eq "OK") { [Console]::Write($picker.SelectedPath) }';
    const child = spawn('powershell.exe', ['-NoProfile','-STA','-Command', script], {windowsHide:true});
    let output = ''; child.stdout.on('data', d => output += d); child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output.trim()) : reject(new Error('資料夾選擇器無法啟動。')));
  });
}
