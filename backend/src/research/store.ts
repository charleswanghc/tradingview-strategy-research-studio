import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parse } from 'csv-parse';
import type { TradingViewContext } from '../../../shared/optimization.types.js';
import type { ResearchPeriod, ResearchRoundState } from '../../../shared/research.types.js';
import type { CommandBridge } from '../contracts/protocol.js';
import { artifactSchema, researchStartSchema, revisionSchema, reviewSchema, sessionSchema, strategyTitle } from '../contracts/research.js';

interface Round {
  id: string; index: number; status: 'running' | 'completed' | 'failed' | 'stopped';
  startedAt: string; updatedAt: string; sourceHash: string; rationale: string;
  browser?: ResearchRoundState; error?: string; csv?: { headers: string[]; rows: number };
  artifacts: Record<string, string>; analysisDecision?: 'continue' | 'finish';
}
interface Session {
  id: string; status: 'awaiting_revision' | 'running' | 'awaiting_analysis' | 'completed' | 'failed' | 'stopped';
  tabId: number; chartSessionId: string; context: TradingViewContext; period: ResearchPeriod;
  goal: string; maxRounds: number; timeoutMs: number; exportXlsx: boolean;
  parameters?: Record<string, number | boolean | string>; timezone?: string;
  createdAt: string; updatedAt: string; rounds: Round[]; stopReason?: string;
}
const hash = (value: string) => createHash('sha256').update(value.replace(/\r\n/g, '\n')).digest('hex');
const uuid = (id: string) => { if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id)) throw new Error('Invalid research ID.'); return id; };

export class ResearchStore {
  private busy = new Set<string>();
  private root: string;
  constructor(private bridge: CommandBridge, dataDirectory: string) { this.root = resolve(dataDirectory, 'research'); }
  private directory(id: string) { return join(this.root, uuid(id)); }
  private roundDirectory(session: Session, round: Round) { return join(this.directory(session.id), `round-${String(round.index).padStart(3, '0')}`); }
  private async save(session: Session) {
    session.updatedAt = new Date().toISOString();
    const path = join(this.directory(session.id), 'session.json');
    await writeFile(`${path}.tmp`, JSON.stringify(session, null, 2)); await rename(`${path}.tmp`, path);
  }
  private async load(id: string): Promise<Session> { return JSON.parse(await readFile(join(this.directory(id), 'session.json'), 'utf8')); }
  private async locked<T>(id: string, work: () => Promise<T>): Promise<T> {
    uuid(id);
    if (this.busy.has(id)) throw new Error('Another operation is updating this research session. Query it before retrying.');
    this.busy.add(id); try { return await work(); } finally { this.busy.delete(id); }
  }
  private summary(session: Session): Record<string, unknown> {
    return { ...session, directory: this.directory(session.id), rounds: session.rounds.map(round => ({
      id: round.id, index: round.index, status: round.status, phase: round.browser?.phase ?? round.status,
      startedAt: round.startedAt, updatedAt: round.updatedAt, sourceHash: round.sourceHash, error: round.error ?? null,
      metrics: round.browser?.metrics ?? null, csv: round.csv ?? null, artifacts: round.artifacts,
      analysisDecision: round.analysisDecision ?? null
    })) };
  }
  async inspect(tabId: number): Promise<Record<string, unknown>> {
    return this.bridge.request('research_environment', { tabId });
  }
  async create(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const args = researchStartSchema.parse(input);
    const environment = await this.bridge.request('research_environment', { tabId: args.tabId, expectedContext: args.expectedContext });
    if (typeof environment.source !== 'string' || environment.source.length > 200000 || typeof environment.sessionId !== 'string') throw new Error('Invalid Pine environment response.');
    const now = new Date().toISOString();
    const session: Session = { id: randomUUID(), status: 'awaiting_revision', tabId: args.tabId,
      chartSessionId: environment.sessionId, context: args.expectedContext, period: args.period, goal: args.goal,
      maxRounds: args.maxRounds, timeoutMs: args.timeoutMs, exportXlsx: args.exportXlsx,
      parameters: args.parameters, timezone: args.timezone, createdAt: now, updatedAt: now, rounds: [] };
    await mkdir(this.directory(session.id), { recursive: true });
    await writeFile(join(this.directory(session.id), 'original-editor.pine'), environment.source, { flag: 'wx' });
    await this.save(session);
    return { session: this.summary(session), nextAction: 'submit_research_revision' };
  }
  private async expectedSource(session: Session): Promise<string> {
    const written = [...session.rounds].reverse().find(round => round.browser?.editorWritten || round.status === 'running');
    return readFile(written ? written.artifacts.source : join(this.directory(session.id), 'original-editor.pine'), 'utf8');
  }
  async submit(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const args = revisionSchema.parse(input);
    return this.locked(args.sessionId, async () => {
      const session = await this.load(args.sessionId);
      if (session.status !== 'awaiting_revision' || session.rounds.length >= session.maxRounds) throw new Error('This session is not waiting for a revision or has reached its round limit.');
      const expectedEditorSource = await this.expectedSource(session);
      const index = session.rounds.length + 1;
      const originalTitle = strategyTitle(args.source);
      const title = `${originalTitle.slice(0, 140)} [TVA ${session.id.slice(0, 8)} #${index}]`;
      const source = args.source.replace(/(^\s*strategy\s*\(\s*(?:title\s*=\s*)?)(["'])([^"'\r\n]+)\2/m,
        (_match, prefix, quote) => `${prefix}${quote}${title}${quote}`);
      if (strategyTitle(source) !== title) throw new Error('The Pine strategy title could not be versioned safely.');
      const now = new Date().toISOString();
      const round: Round = { id: randomUUID(), index, status: 'running', startedAt: now, updatedAt: now,
        sourceHash: hash(source), rationale: args.rationale, artifacts: {} };
      const dir = this.roundDirectory(session, round); await mkdir(dir, { recursive: true });
      round.artifacts = { source: join(dir, 'source.pine'), proposal: join(dir, 'proposal.pine'), metadata: join(dir, 'metadata.json') };
      await writeFile(round.artifacts.source, source, { flag: 'wx' });
      await writeFile(round.artifacts.proposal, args.source, { flag: 'wx' });
      session.rounds.push(round); session.status = 'running'; await this.save(session);
      try {
        const response = await this.bridge.request('research_start_round', { tabId: session.tabId,
          expectedSessionId: session.chartSessionId, request: { roundId: round.id, source, expectedEditorSource,
            strategyTitle: title, expectedContext: session.context, expectedSessionId: session.chartSessionId,
            period: session.period, timeoutMs: session.timeoutMs, exportXlsx: session.exportXlsx,
            parameters: session.parameters, timezone: session.timezone } });
        round.browser = response.round as ResearchRoundState;
        if (round.browser?.roundId !== round.id || round.browser.sessionId !== session.chartSessionId) throw new Error('Invalid research start response.');
        await this.save(session);
      } catch (error) {
        // A timed-out start may already have executed. Preserve its ID and reconcile before any retry.
        round.error = error instanceof Error ? error.message : String(error); await this.save(session);
      }
      return { session: this.summary(session), nextAction: 'get_strategy_research' };
    });
  }
  private async importDownload(session: Session, round: Round, item: ResearchRoundState['downloads'][number]): Promise<string> {
    if (!['csv', 'xlsx'].includes(item.format) || !Number.isInteger(item.downloadId)) throw new Error('Invalid report download.');
    const leaf = item.format === 'csv' ? 'trades.csv' : 'report.xlsx';
    const suffix = `/TradingViewAssistant/${round.id}/${leaf}`;
    if (!item.filename?.replace(/\\/g, '/').endsWith(suffix)) throw new Error('Downloaded artifact did not belong to this research round.');
    const stat = await lstat(item.filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > 100 * 1024 * 1024
      || stat.mtimeMs < Date.parse(round.startedAt) - 2000) throw new Error('Report must be a fresh regular file between 1 byte and 100 MiB.');
    const destination = join(this.roundDirectory(session, round), leaf);
    await copyFile(item.filename, destination);
    if (item.format === 'xlsx') {
      const prefix = (await readFile(destination)).subarray(0, 2).toString();
      if (prefix !== 'PK') throw new Error('The downloaded report is not an XLSX archive.');
    }
    return destination;
  }
  private async csvPage(path: string, offset: number, limit: number, countAll = false) {
    const file = createReadStream(path);
    const stream = file.pipe(parse({ bom: true, skip_empty_lines: true, max_record_size: 1024 * 1024 }));
    file.on('error', error => stream.destroy(error));
    let headers: string[] | undefined; let total = 0; let characters = 0;
    const rows: string[][] = [];
    try {
      for await (const record of stream) {
        if (!headers) {
          headers = record;
          if (headers!.length < 2 || headers!.length > 256 || headers!.some(header => header.length > 2000)
            || !/trade|交易|取引|거래/i.test(headers!.join(' '))) throw new Error('Invalid trading CSV header.');
          continue;
        }
        if (total >= offset && rows.length < limit) {
          const length = JSON.stringify(record).length;
          if (length > 200000) throw new Error('One CSV row is too large for MCP. Read the local file instead.');
          if (characters + length > 200000) break;
          rows.push(record); characters += length;
        }
        total += 1;
        if (!countAll && rows.length === limit) break;
        if (total > 2000000) throw new Error('CSV row count exceeds the two million row limit.');
      }
    } finally { stream.destroy(); file.destroy(); }
    if (!headers) throw new Error('The CSV is empty.');
    return { headers, rows, total };
  }
  private async reconcile(session: Session): Promise<void> {
    if (session.status !== 'running') return;
    const round = session.rounds.at(-1)!;
    const response = await this.bridge.request('research_get_round', { tabId: session.tabId,
      expectedSessionId: session.chartSessionId, roundId: round.id });
    const state = response.round as ResearchRoundState;
    if (!state || state.roundId !== round.id || state.sessionId !== session.chartSessionId) throw new Error('Research round identity did not match.');
    round.browser = state; round.updatedAt = state.updatedAt;
    if (state.status === 'running') { await this.save(session); return; }
    // Import any completed downloads even when a later export failed or the user stopped.
    for (const item of state.downloads || []) {
      round.artifacts[item.format === 'csv' ? 'trades' : 'report'] = await this.importDownload(session, round, item);
    }
    round.status = state.status; round.error = state.error;
    if (state.status === 'completed') {
      if (!round.artifacts.trades || !state.reportEvidence?.completedAt) throw new Error('A completed round must include fresh deep-report evidence and a trades CSV.');
      const csv = await this.csvPage(round.artifacts.trades, 0, 0, true);
      round.csv = { headers: csv.headers!, rows: csv.total };
      session.context = state.context; session.status = 'awaiting_analysis';
    } else { session.status = state.status; session.stopReason = state.error || state.status; }
    await writeFile(round.artifacts.metadata, JSON.stringify({ roundId: round.id, index: round.index,
      sourceHash: round.sourceHash, context: state.context, period: session.period, goal: session.goal,
      parameters: session.parameters, timezone: session.timezone,
      status: state.status, metrics: state.metrics ?? null, reportEvidence: state.reportEvidence ?? null,
      downloads: state.downloads, csv: round.csv, error: state.error }, null, 2));
    await this.save(session);
  }
  async get(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { sessionId } = sessionSchema.parse(input);
    return this.locked(sessionId, async () => {
      const session = await this.load(sessionId);
      try { await this.reconcile(session); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Connection errors are retryable; other errors stop the loop and retain all artifacts.
        if ((error as { code?: string }).code?.startsWith('BRIDGE_')) return { session: this.summary(session), connectionError: message };
        session.status = 'failed'; session.stopReason = message;
        const round = session.rounds.at(-1); if (round) { round.status = 'failed'; round.error = message; }
        await this.save(session);
      }
      return { session: this.summary(session), nextAction: session.status === 'awaiting_analysis' ? 'read_research_artifact, then review_research_round' : session.status };
    });
  }
  async review(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const args = reviewSchema.parse(input);
    return this.locked(args.sessionId, async () => {
      const session = await this.load(args.sessionId); const round = session.rounds.at(-1);
      if (session.status !== 'awaiting_analysis' || round?.index !== args.round) throw new Error('Review must reference the latest completed round awaiting analysis.');
      round.artifacts.analysis = join(this.roundDirectory(session, round), 'analysis.md');
      await writeFile(round.artifacts.analysis, args.analysis); round.analysisDecision = args.decision;
      if (args.decision === 'finish' || session.rounds.length >= session.maxRounds) {
        session.status = 'completed'; session.stopReason = args.decision === 'finish' ? 'Analysis requested finish.' : 'Maximum rounds reached.';
      } else session.status = 'awaiting_revision';
      await this.save(session); return { session: this.summary(session), nextAction: session.status === 'awaiting_revision' ? 'submit_research_revision' : 'finished' };
    });
  }
  async stop(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { sessionId } = sessionSchema.parse(input);
    return this.locked(sessionId, async () => {
      const session = await this.load(sessionId);
      if (session.status === 'running') {
        const round = session.rounds.at(-1)!;
        await this.bridge.request('research_stop_round', { tabId: session.tabId, expectedSessionId: session.chartSessionId, roundId: round.id });
        return { session: this.summary(session), stopping: true };
      }
      if (!['completed', 'failed', 'stopped'].includes(session.status)) { session.status = 'stopped'; session.stopReason = 'Stopped by user.'; await this.save(session); }
      return { session: this.summary(session) };
    });
  }
  async artifact(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const args = artifactSchema.parse(input); const session = await this.load(args.sessionId);
    if (args.round === 0) {
      if (args.artifact !== 'source') throw new Error('Round zero only contains the original editor source.');
      return { text: await readFile(join(this.directory(session.id), 'original-editor.pine'), 'utf8') };
    }
    const round = session.rounds.find(item => item.index === args.round); const path = round?.artifacts[args.artifact];
    if (!round || !path) throw new Error('This artifact has not been saved. Query the round first.');
    if (args.artifact !== 'trades') return { path, text: await readFile(path, 'utf8') };
    const page = await this.csvPage(path, args.offset, args.limit);
    return { path, headers: page.headers, rows: page.rows, offset: args.offset, total: round.csv?.rows ?? null,
      nextOffset: round.csv && args.offset + page.rows.length < round.csv.rows ? args.offset + page.rows.length : null };
  }
  async restoreEditor(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { sessionId } = sessionSchema.parse(input);
    return this.locked(sessionId, async () => {
      const session = await this.load(sessionId);
      if (session.status === 'running') throw new Error('Stop the active round before restoring editor source.');
      const source = await readFile(join(this.directory(session.id), 'original-editor.pine'), 'utf8');
      const expectedSource = await this.expectedSource(session);
      return this.bridge.request('research_restore_editor', { tabId: session.tabId, expectedSessionId: session.chartSessionId, source, expectedSource });
    });
  }
}
