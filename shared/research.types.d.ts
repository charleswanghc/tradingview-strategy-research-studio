import type { TradingViewContext, BacktestMetrics } from './optimization.types';

export interface ResearchPeriod { start: string; end: string; }
export interface ResearchRoundRequest {
  roundId: string;
  source: string;
  expectedEditorSource: string;
  strategyTitle: string;
  expectedContext: TradingViewContext;
  expectedSessionId: string;
  period: ResearchPeriod;
  timeoutMs: number;
  exportXlsx: boolean;
  parameters?: Record<string, number | boolean | string>;
  timezone?: string;
}
export interface ResearchDownload {
  format: 'csv' | 'xlsx';
  downloadId: number;
  filename: string;
  bytes: number;
}
export interface ResearchRoundState {
  roundId: string;
  sessionId: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  phase: string;
  startedAt: string;
  updatedAt: string;
  context: TradingViewContext;
  period: ResearchPeriod;
  editorWritten: boolean;
  metrics?: Omit<BacktestMetrics, 'raw'>;
  reportEvidence?: { text: string; completedAt: string; };
  downloads: ResearchDownload[];
  error?: string;
}
