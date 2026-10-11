// TradingView page injection script for get data from window.TradingView object
const message = {
  errorsNoBacktest: 'There is no backtest data. Try to do a new backtest',
  errorNoDataMessage: 'Can\'t get test results data'
};

window.addEventListener('message', async function (event) {
  // Security check: only accept messages from self (content script)
  if (event.source !== window) return;
  
  const data = event.data;
  if (!data || data.source !== 'tva-content-script') return;

  console.log('[TV-Page] Received message:', data);

  switch (data.action) {
    case 'setStrategyParams':
        try {
            const result = await setStrategyParamsFromPage(data.params); // params is { paramName: value, ... }
            window.postMessage({ 
                source: 'tva-page-context', 
                action: 'setStrategyParamsResult', 
                success: true, 
                result: result 
            }, '*');
        } catch (e) {
            console.error('[TV-Page] Error setStrategyParams:', e);
            window.postMessage({ 
                source: 'tva-page-context', 
                action: 'setStrategyParamsResult', 
                success: false, 
                error: e.message 
            }, '*');
        }
        break;

    case 'getPerformance':
        try {
            const perfData = getPerformanceData();
            window.postMessage({ 
                source: 'tva-page-context', 
                action: 'getPerformanceResult', 
                success: true, 
                data: perfData 
            }, '*');
        } catch (e) {
            console.error('[TV-Page] Error getPerformance:', e);
            window.postMessage({ 
                source: 'tva-page-context', 
                action: 'getPerformanceResult', 
                success: false, 
                error: e.message 
            }, '*');
        }
        break;
  }
});

// --- Core Helper Functions (Adapted from Sample) ---

async function getStrategyDispatcher(timeout = 6000) {
  const dispatcher = locateStrategyDispatcher();
  if (!dispatcher)
    return null;
  await ensureDispatcherReady(dispatcher, timeout);
  return dispatcher;
}

function locateStrategyDispatcher() {
  const tvRoot = window.TradingView;
  if (!tvRoot)
    return null;

  // Try known paths first (fast path)
  const fromOptions = tvRoot?.bottomWidgetBar?._options?.backtestingStrategyDispatcher;
  if (fromOptions)
    return fromOptions;

  const fromWidgets = tvRoot?.bottomWidgetBar?._widgets?.backtesting?._strategyDispatcher;
  if (fromWidgets)
    return fromWidgets;

  const fromChartPage = tvRoot?.onChartPage?.backtestingStrategyDispatcher;
  if (fromChartPage)
    return fromChartPage;

  // Fallback: deep search through common root objects
  const candidates = [
    tvRoot?.bottomWidgetBar,
    tvRoot?.onChartPage,
    tvRoot?.onWidget
  ].filter(Boolean);

  const visited = new WeakSet();
  for (const candidate of candidates) {
    try {
      const found = walkForDispatcher(candidate, 3, visited);
      if (found)
        return found;
    } catch {
      // Ignore errors during walk
    }
  }

  return null;
}

function walkForDispatcher(root, depth, visited) {
  if (!root || depth < 0 || typeof root !== 'object')
    return null;
  if (visited && visited.has(root))
    return null;
  if (visited)
    visited.add(root);
  
  // Handle arrays
  if (Array.isArray(root)) {
    for (const item of root) {
      const found = walkForDispatcher(item, depth, visited);
      if (found)
        return found;
    }
    return null;
  }
  
  // Check if this object looks like a dispatcher
  if (Array.isArray(root._modelStrategies) || Array.isArray(root._strategies))
    return root;

  // Recurse through object properties
  const keys = Object.keys(root);
  for (const key of keys) {
    if (!key || key === '__proto__')
      continue;
    // Skip very long internal keys
    if (key[0] === '_' && key.length > 32)
      continue;
    const value = root[key];
    if (!value || typeof value !== 'object')
      continue;
    const found = walkForDispatcher(value, depth - 1, visited);
    if (found)
      return found;
  }
  return null;
}

async function ensureDispatcherReady(dispatcher, timeout = 4000) {
  if (!dispatcher)
    return null;

  // Collect all promises that might indicate readiness
  const pending = [];
  const pushThenable = (maybe) => {
    if (maybe && typeof maybe.then === 'function')
      pending.push(maybe);
  };

  try {
    if (typeof dispatcher.ready === 'function')
      pushThenable(dispatcher.ready());
  } catch {
  }
  try {
    if (typeof dispatcher.whenReady === 'function')
      pushThenable(dispatcher.whenReady());
  } catch {
  }
  pushThenable(dispatcher._ready);
  pushThenable(dispatcher._filled);
  pushThenable(dispatcher._initPromise);
  pushThenable(dispatcher._applyModelPromise);

  // Wait for all readiness promises
  for (const promise of pending) {
    try {
      await promise;
    } catch (err) {
      console.warn('[TV-Page] Strategy dispatcher readiness wait rejected:', err);
    }
  }

  // Poll until strategies are available or timeout
  const waitTime = Number.isFinite(timeout) ? Math.max(timeout, 0) : 0;
  const deadline = Date.now() + waitTime;
  while (Date.now() < deadline) {
    const strategies = extractStrategies(dispatcher);
    if (strategies.length) {
      if (!Array.isArray(dispatcher._modelStrategies) || !dispatcher._modelStrategies.length)
        dispatcher._modelStrategies = strategies;
      return dispatcher;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  // Final attempt
  const strategies = extractStrategies(dispatcher);
  if (strategies.length && (!Array.isArray(dispatcher._modelStrategies) || !dispatcher._modelStrategies.length))
    dispatcher._modelStrategies = strategies;

  return dispatcher;
}

function extractStrategies(dispatcher) {
  if (!dispatcher)
    return [];
  if (Array.isArray(dispatcher._modelStrategies) && dispatcher._modelStrategies.length)
    return dispatcher._modelStrategies;
  if (Array.isArray(dispatcher._strategies) && dispatcher._strategies.length)
    return dispatcher._strategies;
  if (dispatcher._strategies && typeof dispatcher._strategies.values === 'function') {
    try {
      return Array.from(dispatcher._strategies.values()).filter(Boolean);
    } catch {
    }
  }
  if (dispatcher._strategies && typeof dispatcher._strategies === 'object') {
    const out = [];
    for (const value of Object.values(dispatcher._strategies)) {
      if (!value)
        continue;
      if (Array.isArray(value))
        out.push(...value.filter(Boolean));
      else if (typeof value === 'object')
        out.push(value);
    }
    if (out.length)
      return out;
  }
  return [];
}

function getPerformanceData() {
     // Based on Sample: window.TradingView.bottomWidgetBar._widgets.backtesting._reportWidgetsSet.reportWidget._data.performance
     // Or Dispatcher approach for Deep Backtesting users
     
     let tvData = null;
     const tv = window.TradingView;
     
     try {
         // Standard Backtester
         if (tv.bottomWidgetBar?._widgets?.backtesting?._reportWidgetsSet?.reportWidget?._data?.performance) {
             tvData = tv.bottomWidgetBar._widgets.backtesting._reportWidgetsSet.reportWidget._data.performance;
         } 
         // Deep Backtester / Model Strategies
         else if (tv.bottomWidgetBar?._options?.backtestingStrategyDispatcher?._modelStrategies?.[0]?._reportData?.performance) {
             tvData = tv.bottomWidgetBar._options.backtestingStrategyDispatcher._modelStrategies[0]._reportData.performance;
         }
     } catch (e) {
         console.warn('[TV-Page] Error accessing performance object directly:', e);
     }
     
     if (!tvData) {
         throw new Error('Performance data not found (Backtest might not be finished or started)');
     }
     
     // The raw data usually has keys like "Net Profit %" etc.
     // Sample code maps specific columns. We just want the raw summary.
     // Usually it's in tvData.perfomanceSummary (Array of objects) or similar.
     
     // Sample: tvData might BE the performance object which contains `perfomanceSummary`?
     // Actually Sample code says: reportWidget._data.performance IS the data.
     
     return tvData;
}

async function setStrategyParamsFromPage(paramsMap) { // paramsMap: { 'Length': 14, 'Source': 'Close' }
  const dispatcher = await getStrategyDispatcher();
  if (!dispatcher) throw new Error('Strategy Dispatcher not found');
  
  const strategies = extractStrategies(dispatcher);
  if (!strategies.length) throw new Error('No strategies found on chart');
  
  // Use first strategy for now (simpler)
  const strategy = strategies[0];
  if (!strategy) throw new Error('Strategy object is null');
  
  const inputsRoot = strategy._properties?.inputs || strategy._inputs; // _inputs for some versions? Sample says _properties.inputs
  if (!inputsRoot) throw new Error('Strategy inputs not accessible');
  
  // We need to map friendly names (e.g. "Length") to internal IDs (e.g. "in_0")
  // Sample has a complex `buildInputCatalog`. We can try a simpler scanner first.
  
  const inputMap = {}; // friendlyName -> inputNode
  
  function scanInputs(root) {
      if (!root) return;
      const keys = Object.keys(root);
      // If it's a leaf node with setValue
      if (typeof root.setValue === 'function' || typeof root.setValueSilently === 'function') {
          // Try to find name
          const name = root._name || root._title || (root._schema && root._schema.name);
          if (name) inputMap[name] = root;
          
          // Also handle "Display Name" if possible
           if (root._schema && root._schema.displayName) inputMap[root._schema.displayName] = root;
      }
      
      // Recurse
      for (const key of keys) {
          if (typeof root[key] === 'object') scanInputs(root[key]);
      }
  }
  
  scanInputs(inputsRoot);
  
  // Now apply values
  const results = { updated: [], missing: [] };
  
  for (const [key, value] of Object.entries(paramsMap)) {
      // Try exact match first
      let node = inputMap[key];
      
      // Try "loose" match (ignore case/spaces) if not found
      if (!node) {
          const looseKey = key.toLowerCase().replace(/\s/g, '');
          for (const [name, n] of Object.entries(inputMap)) {
              if (name.toLowerCase().replace(/\s/g, '') === looseKey) {
                  node = n;
                  break;
              }
          }
      }
      
      if (node) {
          try {
              if (typeof node.setValueSilently === 'function') {
                  node.setValueSilently(value);
              } else {
                  node.setValue(value);
              }
              results.updated.push(key);
          } catch(e) {
              console.error(`[TV-Page] Failed to set ${key}:`, e);
          }
      } else {
          results.missing.push(key);
          console.warn(`[TV-Page] Param "${key}" not found in strategy inputs.`);
      }
  }
  
  // Important: Trigger update!
  if (results.updated.length > 0) {
      // Method 1: strategy.updateAllViews
      if (typeof strategy.updateAllViews === 'function') {
           strategy.updateAllViews({type: 'data-source-change', sourceId: ''});
      }
      // Method 2: dispatcher internal methods?
      // Usually updating the property triggers the recalc automatically if using setValue.
  }
  
  return results;
}
