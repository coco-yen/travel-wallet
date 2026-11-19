window.TravelStore = (function () {
  const CACHE_KEY = 'tw_gh_cache_v1', QUEUE_KEY = 'tw_gh_outbox_v1', CRED_KEY = 'tw_gh_credentials_v1';
  const DEFAULT_CURRENCIES = [
    { code: 'TWD', name: '新台幣', symbol: 'NT$', defaultRate: 1 },
    { code: 'JPY', name: '日圓', symbol: '¥', defaultRate: 0.215 },
    { code: 'KRW', name: '韓元', symbol: '₩', defaultRate: 0.024 },
    { code: 'USD', name: '美元', symbol: '$', defaultRate: 32.5 },
    { code: 'EUR', name: '歐元', symbol: '€', defaultRate: 35.2 },
    { code: 'THB', name: '泰銖', symbol: '฿', defaultRate: 0.95 }
  ];

  let userCredentials = { gasUrl: '', gasSecret: '', userGeminiKey: '', userOpenAIKey: '' };
  let state = { Trips: [], Members: [], Expenses: [], ExpenseItems: [], Allocations: [], Payments: [], Taxes: [], TaxExpenseLinks: [], TaxItemAllocations: [], Settlements: [], ExchangeRates: [], Settings: [] };
  let outbox = [];
  let syncStatus = { mode: 'offline_local', lastSyncAt: null, pendingCount: 0, conflicts: [], message: '本機獨立模式' };
  const listeners = new Set();

  function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  function notify() { syncStatus.pendingCount = outbox.length; saveLocalCache(); listeners.forEach(fn => fn(state, syncStatus)); }
  function genId(prefix) { return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`; }

  function loadLocalCache() {
    try {
      const credRaw = localStorage.getItem(CRED_KEY);
      if (credRaw) userCredentials = { ...userCredentials, ...JSON.parse(credRaw) };
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) { const p = JSON.parse(raw); Object.keys(state).forEach(k => { if (Array.isArray(p[k])) state[k] = p[k]; }); }
      const qRaw = localStorage.getItem(QUEUE_KEY);
      if (qRaw) outbox = JSON.parse(qRaw) || [];
    } catch (e) {}
  }

  function saveLocalCache() {
    try {
      localStorage.setItem(CRED_KEY, JSON.stringify(userCredentials));
      localStorage.setItem(CACHE_KEY, JSON.stringify(state));
      localStorage.setItem(QUEUE_KEY, JSON.stringify(outbox));
    } catch (e) {}
  }

  function updateUserCredentials(partial) { userCredentials = { ...userCredentials, ...partial }; saveLocalCache(); notify(); }
  function hasGasConfigured() { return Boolean(userCredentials.gasUrl && userCredentials.gasUrl.startsWith('https://script.google.com/')); }

  async function callGasApi(payload) {
    if (!hasGasConfigured()) throw new Error('尚未設定 Google Apps Script 網址');
    const res = await fetch(userCredentials.gasUrl.trim(), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...payload, secret: userCredentials.gasSecret || '' })
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch (e) { throw new Error('GAS 回傳非 JSON，請確認權限已設為「所有人」'); }
    if (!json.ok) throw new Error(json.message || 'Google Sheets API 錯誤');
    return json;
  }

  async function pullFromCloud() {
    if (!hasGasConfigured()) {
      syncStatus.mode = 'offline_local';
      syncStatus.message = '本機暫存模式（在「設定」貼上 GAS 網址即可同步）';
      notify();
      return false;
    }
    syncStatus.mode = 'syncing'; syncStatus.message = '同步 Google Sheets 中...'; notify();
    try {
      if (outbox.length > 0) await flushOutbox();
      const json = await callGasApi({ action: 'readAll' });
      Object.keys(state).forEach(t => { if (Array.isArray(json.data[t])) state[t] = json.data[t]; });
      syncStatus.mode = 'online'; syncStatus.lastSyncAt = new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
      syncStatus.message = `已與 Google Sheets 同步 (${syncStatus.lastSyncAt})`;
      notify();
      return true;
    } catch (err) {
      syncStatus.mode = 'error'; syncStatus.message = `同步提示：${err.message}`; notify();
      return false;
    }
  }

  function enqueueOperations(ops) {
    outbox.push({ idempotencyKey: genId('batch'), operations: ops, retries: 0, createdAt: new Date().toISOString() });
    notify();
    flushOutbox();
  }

  async function flushOutbox() {
    if (outbox.length === 0 || !hasGasConfigured()) return;
    syncStatus.mode = 'syncing'; syncStatus.message = `正在寫入 ${outbox.length} 筆異動...`; notify();
    while (outbox.length > 0) {
      const batch = outbox[0];
      try {
        const json = await callGasApi({ action: 'syncBatch', idempotencyKey: batch.idempotencyKey, operations: batch.operations });
        if (json.conflicts && json.conflicts.length > 0) {
          syncStatus.conflicts = json.conflicts; syncStatus.mode = 'conflict';
          syncStatus.message = '偵測到多裝置編輯衝突，請按「立即同步」';
          outbox.shift(); notify(); return;
        }
        outbox.shift(); syncStatus.lastSyncAt = new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
      } catch (err) {
        batch.retries += 1; syncStatus.mode = 'error'; syncStatus.message = `同步重試中 (${batch.retries})：${err.message}`; notify();
        setTimeout(() => flushOutbox(), Math.min(30000, 1500 * Math.pow(2, batch.retries)));
        return;
      }
    }
    syncStatus.mode = 'online'; syncStatus.message = `所有變更已同步 (${syncStatus.lastSyncAt})`; notify();
  }

  async function runAiOcr({ imageBase64, mode = 'receipt', provider = 'auto' }) {
    const uGemini = (userCredentials.userGeminiKey || '').trim();
    const uOpenAI = (userCredentials.userOpenAIKey || '').trim();

    const receiptPrompt = `你是一個精準的多國語言收據財務辨識助理。請分析這張收據圖片並輸出純 JSON（不要包含 markdown 標記）。
嚴格遵守以下規則：
1. 辨識店家名稱、消費日期時間 (YYYY-MM-DDTHH:mm)、幣別代碼 (如 JPY, TWD, KRW, USD, EUR)。
2. 逐項擷取商品原文名稱 (originalName)、翻譯成自然道地的繁體中文名稱 (zhName)、數量 (quantity)、單價 (unitPriceOriginal)、小計 (subtotalOriginal)。
3. 辨識整張收據的折扣 (discountOriginal, 正數)、稅額 (taxOriginal)、手續費 (feeOriginal)、總金額 (totalOriginal)。
4. 判斷每個品項是否可能為免稅/退稅商品 (isTaxRefundEligible: boolean)。
5. 若有任何文字模糊、反光、被遮擋或不確定，絕對不可自行猜測數字或名稱，請將該欄位設為 null，並將該品項或整體的 uncertain 設為 true，在 uncertainReason 說明原因。
6. 絕對不要猜測或指定由哪位旅伴負擔。
回傳 JSON：
{"merchantName": string|null, "dateTime": string|null, "currency": string|null, "items": [{"originalName": string, "zhName": string, "quantity": number|null, "unitPriceOriginal": number|null, "subtotalOriginal": number|null, "isTaxRefundEligible": boolean, "uncertain": boolean, "uncertainReason": string}], "discountOriginal": number, "taxOriginal": number, "feeOriginal": number, "totalOriginal": number|null, "overallUncertain": boolean, "notes": string}`;

    const taxPrompt = `你是一個精準的退稅單辨識助理。請分析這張退稅單或免稅收據圖片並輸出純 JSON。若欄位模糊不確定，設為 null 並將 uncertain 設為 true，不可猜測。
回傳 JSON：{"title": string|null, "dateTime": string|null, "currency": string|null, "totalRefundOriginal": number|null, "breakdowns": [{"merchantName": string|null, "refundOriginal": number|null, "uncertain": boolean}], "uncertain": boolean, "notes": string}`;

    const sysPrompt = mode === 'tax' ? taxPrompt : receiptPrompt;
    const userInstruction = mode === 'tax' ? '請辨識這張退稅單明細並嚴格依 JSON 格式輸出' : '請辨識這張消費收據並將商品翻譯為繁體中文，嚴格依 JSON 格式輸出';

    let directProvider = null;
    if (provider === 'gemini' && uGemini) directProvider = 'gemini';
    else if (provider === 'openai' && uOpenAI) directProvider = 'openai';
    else if (provider === 'auto' && uGemini) directProvider = 'gemini';
    else if (provider === 'auto' && uOpenAI) directProvider = 'openai';

    if (directProvider === 'gemini') {
      const match = imageBase64.match(/^data:(.+?);base64,(.+)$/);
      const mimeType = match ? match[1] : 'image/jpeg';
      const rawBase64 = match ? match[2] : imageBase64;
      const modelsToTry = ['gemini-3.8-flash', 'gemini-3.5-flash-lite'];
      let lastErrorMsg = 'Gemini 伺服器忙碌中，請稍後再試';

      for (const modelName of modelsToTry) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(uGemini)}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: sysPrompt }] },
            contents: [{ role: 'user', parts: [{ text: userInstruction }, { inlineData: { mimeType, data: rawBase64 } }] }],
            generationConfig: { temperature: 0.1, responseMimeType: 'application/json' }
          })
        });
        const data = await res.json();
        if (res.ok) {
          const textOut = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
          return {
            ok: true,
            providerUsed: `gemini (${modelName})`,
            keySource: 'byok_direct',
            result: JSON.parse(textOut.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim())
          };
        }
        lastErrorMsg = data.error?.message || lastErrorMsg;
      }
      throw new Error(lastErrorMsg);
    }

    if (directProvider === 'openai') {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${uOpenAI}` },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          temperature: 0.1,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: sysPrompt },
            { role: 'user', content: [{ type: 'text', text: userInstruction }, { type: 'image_url', image_url: { url: imageBase64, detail: 'high' } }] }
          ]
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'OpenAI API 呼叫失敗');
      return {
        ok: true,
        providerUsed: 'openai',
        keySource: 'byok_direct',
        result: JSON.parse(data.choices?.[0]?.message?.content || '{}')
      };
    }

    if (hasGasConfigured()) {
      return await callGasApi({ action: 'ocr', imageBase64, mode, provider });
    }

    throw new Error('請先至「設定」貼上您自己的 Gemini API Key（AIzaSy... 開頭）或 OpenAI API Key。');
  }

  function mutate(operations) {
    const now = new Date().toISOString();
    const preparedOps = operations.map(op => {
      const { table, type } = op;
      if (type === 'upsert') {
        const idx = state[table].findIndex(r => r.id === op.record.id);
        const existing = idx >= 0 ? state[table][idx] : null;
        const expectedVersion = existing ? Number(existing.version || 1) : null;
        const nextRecord = { ...existing, ...op.record, version: existing ? Number(existing.version || 1) + 1 : 1, createdAt: existing ? existing.createdAt : (op.record.createdAt || now), updatedAt: now };
        if (idx >= 0) state[table][idx] = nextRecord; else state[table].push(nextRecord);
        return { table, type: 'upsert', record: nextRecord, expectedVersion };
      } else if (type === 'delete') {
        state[table] = state[table].filter(r => r.id !== op.id);
        return { table, type: 'delete', id: op.id };
      }
      return op;
    });
    enqueueOperations(preparedOps);
  }

  function getActiveTripId() {
    const saved = localStorage.getItem('tw_active_trip_id');
    if (saved && state.Trips.some(t => t.id === saved)) return saved;
    return state.Trips[0]?.id || null;
  }

  function setActiveTripId(tripId) { localStorage.setItem('tw_active_trip_id', tripId); notify(); }
  function exportJsonBackup() { return JSON.stringify({ app: 'Travel Wallet (iPhone Pro Edition)', schemaVersion: '6.0', exportedAt: new Date().toISOString(), data: state }, null, 2); }
  async function importJsonBackup(jsonText) {
    const parsed = JSON.parse(jsonText);
    const incoming = parsed.data || parsed;
    Object.keys(state).forEach(k => { if (Array.isArray(incoming[k])) state[k] = incoming[k]; });
    outbox = []; notify();
    if (hasGasConfigured()) {
      await callGasApi({ action: 'restoreFull', idempotencyKey: genId('restore'), data: state });
    }
  }

  function loadSeedTestData() {
    const now = new Date().toISOString(), tripId = 'trip_tokyo_2026';
    state = {
      ...state,
      Trips: [{ id: tripId, name: '2026 東京五天四夜財務帳本', baseCurrency: 'TWD', startDate: '2026-11-10', endDate: '2026-11-14', status: 'active', version: 1, createdAt: now, updatedAt: now }],
      Members: [
        { id: 'mem_a', tripId, name: '小安 (A)', avatarColor: '#C86D3B', note: '主刷卡人', isActive: true, version: 1, createdAt: now, updatedAt: now },
        { id: 'mem_b', tripId, name: '阿明 (B)', avatarColor: '#8B5E3C', note: '現金擔當', isActive: true, version: 1, createdAt: now, updatedAt: now },
        { id: 'mem_c', tripId, name: '小美 (C)', avatarColor: '#D99B52', note: '藥妝採購', isActive: true, version: 1, createdAt: now, updatedAt: now }
      ],
      Expenses: [], ExpenseItems: [], Allocations: [], Payments: [], Taxes: [], TaxExpenseLinks: [], TaxItemAllocations: [], Settlements: []
    };
    setActiveTripId(tripId); notify();
  }

  return {
    DEFAULT_CURRENCIES, getState: () => state, getSyncStatus: () => syncStatus,
    getUserCredentials: () => userCredentials, updateUserCredentials, hasGasConfigured,
    runAiOcr, subscribe, genId, loadLocalCache, pullFromCloud, flushOutbox, mutate,
    getActiveTripId, setActiveTripId, exportJsonBackup, importJsonBackup, loadSeedTestData
  };
})();
