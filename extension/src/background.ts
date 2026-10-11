import { installMcpBridge } from './mcp-bridge.js';
import { installResearchBackground } from './research-background.js';

installResearchBackground();
installMcpBridge();
console.info('[LSRS] Background service worker ready.');

chrome.runtime.onInstalled.addListener(() => {
  console.info('[LSRS] Extension installed.');
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.action === 'ping') {
    sendResponse({ status: 'pong' });
    return;
  }

  if (message?.type === 'OPTIMIZATION_JOB_UPDATED') {
    const job = message.job;
    if (job?.status === 'completed' || job?.status === 'stopped' || job?.status === 'failed') {
      const title = job.status === 'completed'
        ? 'TradingView optimization completed'
        : job.status === 'stopped'
          ? 'TradingView optimization stopped'
          : 'TradingView optimization failed';
      const messageText = `${job.context?.strategyName || 'Strategy'} · ${job.completedIterations || 0}/${job.totalIterations || 0}`;

      chrome.notifications.create(`tva-${job.id}-${job.status}`, {
        type: 'basic',
        iconUrl: 'assets/icon-128.png',
        title,
        message: messageText
      }, () => {
        if (chrome.runtime.lastError) {
          console.warn('[LSRS] Notification failed:', chrome.runtime.lastError.message);
        }
      });
    }
  }
});
