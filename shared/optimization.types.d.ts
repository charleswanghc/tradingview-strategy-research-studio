export type ParameterKind = 'number' | 'boolean' | 'select';
export type ParameterValue = number | boolean | string;

export interface DetectedParameter {
  id: string;
  name: string;
  kind: ParameterKind;
  currentValue: ParameterValue;
  options?: string[];
  start?: number;
  end?: number;
  step?: number;
}

export interface OptimizationParameter extends DetectedParameter {
  enabled: boolean;
  values?: ParameterValue[];
}

export type ObjectiveMetric =
  | 'netProfit'
  | 'netProfitPercent'
  | 'maxDrawdown'
  | 'winRate'
  | 'profitFactor'
  | 'sharpeRatio'
  | 'sortinoRatio'
  | 'totalTrades';

export type ObjectiveDirection = 'maximize' | 'minimize';

export interface OptimizationOptions {
  objective: ObjectiveMetric;
  direction: ObjectiveDirection;
  maxIterations: number;
  timeoutMs: number;
  delayMs: number;
  restoreOriginals: boolean;
}

export interface TradingViewContext {
  strategyName: string;
  symbol: string;
  interval: string;
  url: string;
}

export interface OptimizationRequest {
  parameters: OptimizationParameter[];
  options: OptimizationOptions;
  context?: Partial<TradingViewContext>;
}

export interface BacktestMetrics {
  netProfit: number | null;
  netProfitPercent: number | null;
  maxDrawdown: number | null;
  maxDrawdownPercent: number | null;
  winRate: number | null;
  profitFactor: number | null;
  sharpeRatio: number | null;
  sortinoRatio: number | null;
  totalTrades: number | null;
  profitableTrades: number | null;
  raw: Record<string, unknown>;
}

export type OptimizationResultStatus = 'success' | 'error';

export interface OptimizationResult {
  iteration: number;
  parameters: Record<string, ParameterValue>;
  metrics: BacktestMetrics;
  score: number | null;
  durationMs: number;
  status: OptimizationResultStatus;
  error?: string;
  createdAt: string;
}

export type OptimizationJobStatus =
  | 'preparing'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'completed'
  | 'failed';

export interface TradingViewBinding {
  tabId: number;
  sessionId: string;
}

export interface OptimizationJob {
  binding?: TradingViewBinding;
  id: string;
  status: OptimizationJobStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  context: TradingViewContext;
  request: OptimizationRequest;
  totalIterations: number;
  plannedIterations: number;
  completedIterations: number;
  failedIterations: number;
  currentParameters?: Record<string, ParameterValue>;
  results: OptimizationResult[];
  originalParameters: Record<string, ParameterValue>;
  error?: string;
}

export interface ReportIndexEntry {
  id: string;
  status: OptimizationJobStatus;
  createdAt: string;
  updatedAt: string;
  strategyName: string;
  symbol: string;
  interval: string;
  completedIterations: number;
  totalIterations: number;
  objective: ObjectiveMetric;
}

export interface OptimizationProgressMessage {
  type: 'OPTIMIZATION_JOB_UPDATED';
  job: OptimizationJob;
}

