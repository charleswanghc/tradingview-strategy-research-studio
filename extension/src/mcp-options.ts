(() => {
  const key = 'lsrs:mcp-settings';
  const urlInput = document.getElementById('bridge-url') as HTMLInputElement;
  const tokenInput = document.getElementById('bridge-token') as HTMLInputElement;
  const enabledInput = document.getElementById('bridge-enabled') as HTMLInputElement;
  const fileInput = document.getElementById('pairing-file') as HTMLInputElement;
  const message = document.getElementById('save-message')!;
  const state = document.getElementById('connection-state')!;
  const error = document.getElementById('connection-error')!;
  const labels: Record<string, string> = { disabled: '尚未啟用', connecting: '連線中…',
    connected: '已連線', disconnected: '尚未連上 MCP 服務', error: '設定需要修正' };
  function valid(urlValue: string, token: string): boolean {
    try {
      const url = new URL(urlValue);
      return url.protocol === 'ws:' && url.hostname === '127.0.0.1' && url.pathname === '/bridge'
        && !url.search && !url.hash && !url.username && !url.password
        && Number(url.port) >= 1024 && Number(url.port) <= 65535 && /^[a-f0-9]{64}$/.test(token);
    } catch { return false; }
  }
  function renderStatus(value: any): void {
    state.textContent = labels[value?.state] || '尚未啟用';
    error.textContent = value?.error || '';
  }
  void chrome.storage.local.get([key, 'lsrs:mcp-status']).then(stored => {
    const settings = stored[key];
    if (settings) { urlInput.value = settings.url; tokenInput.value = settings.token; enabledInput.checked = !!settings.enabled; }
    renderStatus(stored['lsrs:mcp-status']);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes['lsrs:mcp-status']) renderStatus(changes['lsrs:mcp-status'].newValue);
  });
  fileInput.addEventListener('change', () => {
    void (async () => {
      try {
        const file = fileInput.files?.[0];
        if (!file) return;
        if (file.size > 10000) throw new Error('配對檔過大。');
        const settings = JSON.parse(await file.text());
        if (settings.version !== 1 || !valid(settings.url, settings.token)) throw new Error('配對檔格式不正確。');
        urlInput.value = settings.url;
        tokenInput.value = settings.token;
        enabledInput.checked = true;
        message.textContent = '已匯入，請按「儲存連線設定」。';
      } catch (caught) { message.textContent = caught instanceof Error ? caught.message : '無法讀取配對檔。'; }
    })();
  });
  document.getElementById('connection-form')!.addEventListener('submit', event => {
    event.preventDefault();
    if (enabledInput.checked && !valid(urlInput.value.trim(), tokenInput.value.trim())) {
      message.textContent = '請匯入有效的本機配對檔。'; return;
    }
    void chrome.storage.local.set({ [key]: { url: urlInput.value.trim(), token: tokenInput.value.trim(), enabled: enabledInput.checked } })
      .then(() => { message.textContent = '已儲存，連線狀態會自動更新。'; })
      .catch(() => { message.textContent = '儲存失敗，請重新開啟設定頁。'; });
  });
})();
