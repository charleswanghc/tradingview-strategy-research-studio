import { pineEditorOperation } from './research-page.js';

export function installResearchBackground(api: typeof chrome = chrome): void {
  type Pending = { tabId: number; chartUrl: string; strategyTitle: string; roundId: string; format: 'csv' | 'xlsx'; started: number; id?: number;
    timer: ReturnType<typeof setTimeout>; resolve: (value: any) => void; reject: (error: Error) => void; };
  let pending: Pending | undefined;
  const filename = (item: Pending) => `LocalStrategyResearchStudio/${item.roundId}/${item.format === 'csv' ? 'trades.csv' : 'report.xlsx'}`;
  const matches = (item: chrome.downloads.DownloadItem, request: Pending) => {
    const origin = new URL(item.url.startsWith('blob:') ? item.url.slice(5) : item.url);
    const marker = /\[TVA ([a-f0-9]{8}) #(\d+)\]/.exec(request.strategyTitle);
    const versionedFilename = !!marker && item.filename.toLowerCase().replace(/[^a-z0-9]/g, '').includes(`tva${marker[1]}${marker[2]}`);
    return Date.parse(item.startTime) >= request.started - 1000 && Date.now() - request.started < 120000
      && origin.hostname === new URL(request.chartUrl).hostname
      && (item.referrer === request.chartUrl || versionedFilename)
      && item.filename.toLowerCase().endsWith(`.${request.format}`);
  };
  const fail = (error: Error) => { if (!pending) return; const old = pending; pending = undefined; clearTimeout(old.timer); old.reject(error); };
  api.downloads.onDeterminingFilename.addListener((item, suggest) => {
    try {
      if (pending && pending.id === undefined && matches(item, pending)) {
        pending.id = item.id;
        suggest({ filename: filename(pending), conflictAction: 'uniquify' });
        return;
      }
    } catch { /* Ignore unrelated downloads. */ }
    suggest();
  });
  api.downloads.onChanged.addListener(change => {
    if (!pending || change.id !== pending.id) return;
    if (change.state?.current === 'interrupted' || change.error) { fail(new Error('Report download was interrupted.')); return; }
    if (change.state?.current !== 'complete') return;
    const request = pending;
    void api.downloads.search({ id: change.id }).then(items => {
      if (pending !== request) return;
      const item = items[0];
      if (!item || item.state !== 'complete' || !item.filename.replace(/\\/g, '/').endsWith(filename(request))) {
        fail(new Error('Report download filename did not match this research round.')); return;
      }
      pending = undefined; clearTimeout(request.timer);
      request.resolve({ format: request.format, downloadId: item.id, filename: item.filename, bytes: item.fileSize });
    }).catch(error => fail(error));
  });
  api.runtime.onMessage.addListener((message, sender, respond) => {
    if (!['RESEARCH_EDITOR', 'RESEARCH_EXPORT', 'RESEARCH_CANCEL_EXPORT'].includes(message?.type)) return;
    const tabId = sender.tab?.id;
    if (!tabId || !/^https?:\/\/([a-z0-9-]+\.)*tradingview\.com\/chart\//i.test(sender.tab?.url || '')) {
      respond({ error: 'Research requests require a TradingView chart content script.' }); return;
    }
    void (async () => {
      if (message.type === 'RESEARCH_CANCEL_EXPORT') {
        if (pending?.tabId === tabId && pending.roundId === message.roundId) fail(new Error('Research stopped during export.'));
        return { cancelled: true };
      }
      if (message.type === 'RESEARCH_EDITOR') {
        const results = await api.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: pineEditorOperation,
          args: [message.action, message.source || '', message.expectedSource] });
        const result = results[0];
        if (!result?.result) throw new Error((result as any)?.error?.message || 'Could not access the Pine Editor.');
        return result.result;
      }
      if (pending) throw new Error('Another report export is in progress.');
      if (!/^[a-f0-9-]{36}$/.test(message.roundId) || !['csv', 'xlsx'].includes(message.format)
        || typeof message.strategyTitle !== 'string' || message.strategyTitle.length > 200) throw new Error('Invalid report export request.');
      return await new Promise((resolve, reject) => {
        const request: Pending = { tabId, chartUrl: sender.tab!.url!, strategyTitle: message.strategyTitle,
          roundId: message.roundId, format: message.format, started: Date.now(), resolve, reject,
          timer: setTimeout(() => fail(new Error('Report download did not complete within 120 seconds.')), 120000) };
        pending = request;
        void api.tabs.sendMessage(tabId, { type: 'TRIGGER_RESEARCH_EXPORT', roundId: message.roundId, format: message.format })
          .then(result => { if (result?.status !== 'TRIGGERED') fail(new Error(result?.error || 'Report export control was not available.')); })
          .catch(error => fail(error));
      });
    })().then(result => respond({ result })).catch(error => respond({ error: error instanceof Error ? error.message : String(error) }));
    return true;
  });
}
