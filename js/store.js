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

  let userCredentials = {
    gasUrl: '',
    gasSecret: '',
    userGeminiKey: '',
    userOpenAIKey: ''
  };

  let state = { Trips: [], Members: [], Expenses: [], ExpenseItems: [], Allocations: [], Payments: [], Taxes: [], TaxExpenseLinks: [], TaxItemAllocations: [], Settlements: [], ExchangeRates: [], Settings: [] };
  let outbox = [];
  let syncStatus = {
    mode: 'offline_local',
    lastSyncAt: null,
    pendingCount: 0,
    conflicts: [],
    message: '本機獨立模式（請至「7. 資料與金鑰設定」貼上 Google Apps Script 網址啟用雲端同步）'
  };
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

  function updateUserCredentials(partial) {
    userCredentials = { ...userCredentials, ...partial };
    saveLocalCache();
    notify();
  }

  function hasGasConfigured() {
    return Boolean(userCredentials.gasUrl && userCredentials.gasUrl.startsWith('https://script.google.com/'));
  }

  async function callGasApi(payload) {
    if (!hasGasConfigured()) throw new Error('尚未設定 Google Apps Script 網址');
    const res = await fetch(userCredentials.gasUrl.trim(), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...payload, secret: userCredentials.gasSecret || '' })
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      throw new Error('Google Apps Script 回傳非 JSON，請確認部署權限「誰可以存取」已設為「所有人」');
    }
    if (!json.ok) throw new Error(json.message || 'Google Sheets API 錯誤');
    return json;
  }

  async function pullFromCloud() {
    if (!hasGasConfigured()) {
      syncStatus.mode = 'offline_local';
      syncStatus.message = '本機暫存模式（在「7. 資料與金鑰設定」貼上 GAS 網址即可多裝置雲端同步）';
      notify();
      return false;
    }
    syncStatus.mode = 'syncing'; syncStatus.message = '正在與 Google Sheets 同步...'; notify();
    try {
      if (outbox.length > 0) await flushOutbox();
      const json = await callGasApi({ action: 'readAll' });
      Object.keys(state).forEach(t => { if (Array.isArray(json.data[t])) state[t] = json.data[t]; });
      syncStatus.mode = 'online'; syncStatus.lastSyncAt = new Date().toLocaleTimeString('zh-TW');
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
    syncStatus.mode = 'syncing'; syncStatus.message = `正在寫入 ${outbox.length} 筆異動至 Google Sheets...`; notify();
    while (outbox.length > 0) {
      const batch = outbox[0];
      try {
        const json = await callGasApi({ action: 'syncBatch', idempotencyKey: batch.idempotencyKey, operations: batch.operations });
        if (json.conflicts && json.conflicts.length > 0) {
          syncStatus.conflicts = json.conflicts; syncStatus.mode = 'conflict';
          syncStatus.message = '偵測到多裝置編輯衝突，請按「立即同步」更新';
          outbox.shift(); notify(); return;
        }
        outbox.shift(); syncStatus.lastSyncAt = new Date().toLocaleTimeString('zh-TW');
      } catch (err) {
        batch.retries += 1; syncStatus.mode = 'error'; syncStatus.message = `同步失敗重試中 (${batch.retries})：${err.message}`; notify();
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
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(uGemini)}`;
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
      if (!res.ok) throw new Error(data.error?.message || 'Gemini API 呼叫失敗');
      const textOut = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
      return {
        ok: true,
        providerUsed: 'gemini',
        keySource: 'byok_direct',
        result: JSON.parse(textOut.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim())
      };
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

    throw new Error('請先至「7. 資料與金鑰設定」貼上您自己的 Gemini API Key 或 OpenAI API Key（僅存於您的個人瀏覽器，不會外洩）。');
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
  function exportJsonBackup() { return JSON.stringify({ app: 'Travel Wallet (GitHub Pages Edition)', schemaVersion: '2.0', exportedAt: new Date().toISOString(), data: state }, null, 2); }
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
      Expenses: [
        { id: 'exp_case_a', tripId, dateTime: '2026-11-10T12:30', merchantName: '一蘭拉麵 新宿店 (案例A)', payerMemberId: 'mem_a', paymentMethod: 'credit_card', cardNote: '富邦 J 卡', transitCardName: '', currency: 'JPY', originalAmount: 3000, exchangeRate: 0.22, twdAmount: 660, discountOriginal: 0, taxOriginal: 0, feeOriginal: 0, receiptImageData: '', note: 'A 刷卡 3,000 JPY，B 當場給 A 1,000 JPY 現金', version: 1, createdAt: now, updatedAt: now },
        { id: 'exp_case_b', tripId, dateTime: '2026-11-10T15:00', merchantName: '東京芭娜娜伴手禮 (案例B)', payerMemberId: 'mem_a', paymentMethod: 'cash', cardNote: '', transitCardName: '', currency: 'JPY', originalAmount: 3600, exchangeRate: 0.22, twdAmount: 792, discountOriginal: 0, taxOriginal: 0, feeOriginal: 0, receiptImageData: '', note: '共買 3 盒，A 1 盒、B 2 盒', version: 1, createdAt: now, updatedAt: now },
        { id: 'exp_case_c1', tripId, dateTime: '2026-11-11T14:20', merchantName: '松本清 銀座旗艦店 (案例C/複合退稅店1)', payerMemberId: 'mem_a', paymentMethod: 'credit_card', cardNote: '國泰 CUBE 卡', transitCardName: '', currency: 'JPY', originalAmount: 11000, exchangeRate: 0.22, twdAmount: 2420, discountOriginal: 0, taxOriginal: 0, feeOriginal: 0, receiptImageData: '', note: '10,000 日圓藥妝符合退稅，1,000 日圓現場飲品不符合退稅', version: 1, createdAt: now, updatedAt: now },
        { id: 'exp_case_c2', tripId, dateTime: '2026-11-11T19:45', merchantName: '唐吉訶德 澀谷店 (複合退稅店2)', payerMemberId: 'mem_c', paymentMethod: 'credit_card', cardNote: '玉山熊本熊卡', transitCardName: '', currency: 'JPY', originalAmount: 6000, exchangeRate: 0.22, twdAmount: 1320, discountOriginal: 0, taxOriginal: 0, feeOriginal: 0, receiptImageData: '', note: '跨店合併機場退稅收據 2', version: 1, createdAt: now, updatedAt: now },
        { id: 'exp_case_d', tripId, dateTime: '2026-11-12T09:15', merchantName: 'Suica 儲值與特快車票 (案例D)', payerMemberId: 'mem_a', paymentMethod: 'transit_card', cardNote: '', transitCardName: 'Mobile Suica', currency: 'JPY', originalAmount: 5000, exchangeRate: 0.25, twdAmount: 1250, discountOriginal: 0, taxOriginal: 0, feeOriginal: 0, receiptImageData: '', note: '實際台幣扣款 1,250 元，測試精確分帳', version: 1, createdAt: now, updatedAt: now }
      ],
      ExpenseItems: [
        { id: 'itm_a1', expenseId: 'exp_case_a', tripId, originalName: '天然とんこつラーメン x2', zhName: '天然豚骨拉麵 2碗', quantity: 2, unitPriceOriginal: 1500, subtotalOriginal: 3000, allocatedTwd: 660, isTaxRefundEligible: false, uncertain: false, version: 1, createdAt: now, updatedAt: now },
        { id: 'itm_b1', expenseId: 'exp_case_b', tripId, originalName: '東京ばな奈 8個入', zhName: '東京芭娜娜禮盒 (8入)', quantity: 3, unitPriceOriginal: 1200, subtotalOriginal: 3600, allocatedTwd: 792, isTaxRefundEligible: false, uncertain: false, version: 1, createdAt: now, updatedAt: now },
        { id: 'itm_c1_1', expenseId: 'exp_case_c1', tripId, originalName: 'アリナミンEXプラス', zhName: '合利他命 EX Plus (可退稅)', quantity: 2, unitPriceOriginal: 5000, subtotalOriginal: 10000, allocatedTwd: 2200, isTaxRefundEligible: true, uncertain: false, version: 1, createdAt: now, updatedAt: now },
        { id: 'itm_c1_2', expenseId: 'exp_case_c1', tripId, originalName: 'ミネラルウォーター', zhName: '礦泉水現場飲用 (不可退稅)', quantity: 5, unitPriceOriginal: 200, subtotalOriginal: 1000, allocatedTwd: 220, isTaxRefundEligible: false, uncertain: false, version: 1, createdAt: now, updatedAt: now },
        { id: 'itm_c2_1', expenseId: 'exp_case_c2', tripId, originalName: '抹茶お菓子セット', zhName: '宇治抹茶零食組 (可退稅)', quantity: 1, unitPriceOriginal: 6000, subtotalOriginal: 6000, allocatedTwd: 1320, isTaxRefundEligible: true, uncertain: false, version: 1, createdAt: now, updatedAt: now },
        { id: 'itm_d1', expenseId: 'exp_case_d', tripId, originalName: '成田エクスプレス特急券', zhName: 'N’EX 成田特快車票 (3人)', quantity: 3, unitPriceOriginal: 1666.67, subtotalOriginal: 5000, allocatedTwd: 1250, isTaxRefundEligible: false, uncertain: false, version: 1, createdAt: now, updatedAt: now }
      ],
      Allocations: [
        { id: 'alc_a1', expenseId: 'exp_case_a', expenseItemId: 'itm_a1', tripId, memberId: 'mem_a', splitType: 'equal', allocatedQty: 1, allocatedOriginal: 1500, allocatedTwd: 330, version: 1, createdAt: now, updatedAt: now },
        { id: 'alc_a2', expenseId: 'exp_case_a', expenseItemId: 'itm_a1', tripId, memberId: 'mem_b', splitType: 'equal', allocatedQty: 1, allocatedOriginal: 1500, allocatedTwd: 330, version: 1, createdAt: now, updatedAt: now },
        { id: 'alc_b1', expenseId: 'exp_case_b', expenseItemId: 'itm_b1', tripId, memberId: 'mem_a', splitType: 'quantity', allocatedQty: 1, allocatedOriginal: 1200, allocatedTwd: 264, version: 1, createdAt: now, updatedAt: now },
        { id: 'alc_b2', expenseId: 'exp_case_b', expenseItemId: 'itm_b1', tripId, memberId: 'mem_b', splitType: 'quantity', allocatedQty: 2, allocatedOriginal: 2400, allocatedTwd: 528, version: 1, createdAt: now, updatedAt: now },
        { id: 'alc_c1_1', expenseId: 'exp_case_c1', expenseItemId: 'itm_c1_1', tripId, memberId: 'mem_a', splitType: 'equal', allocatedQty: 1, allocatedOriginal: 5000, allocatedTwd: 1100, version: 1, createdAt: now, updatedAt: now },
        { id: 'alc_c1_2', expenseId: 'exp_case_c1', expenseItemId: 'itm_c1_1', tripId, memberId: 'mem_c', splitType: 'equal', allocatedQty: 1, allocatedOriginal: 5000, allocatedTwd: 1100, version: 1, createdAt: now, updatedAt: now },
        { id: 'alc_c1_3', expenseId: 'exp_case_c1', expenseItemId: 'itm_c1_2', tripId, memberId: 'mem_b', splitType: 'personal', allocatedQty: 5, allocatedOriginal: 1000, allocatedTwd: 220, version: 1, createdAt: now, updatedAt: now },
        { id: 'alc_c2_1', expenseId: 'exp_case_c2', expenseItemId: 'itm_c2_1', tripId, memberId: 'mem_b', splitType: 'equal', allocatedQty: 0.5, allocatedOriginal: 3000, allocatedTwd: 660, version: 1, createdAt: now, updatedAt: now },
        { id: 'alc_c2_2', expenseId: 'exp_case_c2', expenseItemId: 'itm_c2_1', tripId, memberId: 'mem_c', splitType: 'equal', allocatedQty: 0.5, allocatedOriginal: 3000, allocatedTwd: 660, version: 1, createdAt: now, updatedAt: now },
        { id: 'alc_d1', expenseId: 'exp_case_d', expenseItemId: 'itm_d1', tripId, memberId: 'mem_a', splitType: 'equal', allocatedQty: 1, allocatedOriginal: 1666.67, allocatedTwd: 417, version: 1, createdAt: now, updatedAt: now },
        { id: 'alc_d2', expenseId: 'exp_case_d', expenseItemId: 'itm_d1', tripId, memberId: 'mem_b', splitType: 'equal', allocatedQty: 1, allocatedOriginal: 1666.67, allocatedTwd: 417, version: 1, createdAt: now, updatedAt: now },
        { id: 'alc_d3', expenseId: 'exp_case_d', expenseItemId: 'itm_d1', tripId, memberId: 'mem_c', splitType: 'equal', allocatedQty: 1, allocatedOriginal: 1666.66, allocatedTwd: 416, version: 1, createdAt: now, updatedAt: now }
      ],
      Payments: [
        { id: 'pay_a1', tripId, dateTime: '2026-11-10T12:35', fromMemberId: 'mem_b', toMemberId: 'mem_a', currency: 'JPY', originalAmount: 1000, exchangeRate: 0.22, twdAmount: 220, paymentMethod: 'cash', relatedExpenseId: 'exp_case_a', note: '拉麵店現場給 A 1,000 日圓', version: 1, createdAt: now, updatedAt: now },
        { id: 'pay_e1', tripId, dateTime: '2026-11-10T20:00', fromMemberId: 'mem_c', toMemberId: 'mem_a', currency: 'TWD', originalAmount: 200, exchangeRate: 1, twdAmount: 200, paymentMethod: 'bank_transfer', relatedExpenseId: '', note: '分次還款第 1 筆', version: 1, createdAt: now, updatedAt: now },
        { id: 'pay_e2', tripId, dateTime: '2026-11-11T21:00', fromMemberId: 'mem_c', toMemberId: 'mem_a', currency: 'TWD', originalAmount: 300, exchangeRate: 1, twdAmount: 300, paymentMethod: 'bank_transfer', relatedExpenseId: '', note: '分次還款第 2 筆', version: 1, createdAt: now, updatedAt: now },
        { id: 'pay_e3', tripId, dateTime: '2026-11-12T10:00', fromMemberId: 'mem_c', toMemberId: 'mem_a', currency: 'TWD', originalAmount: 150, exchangeRate: 1, twdAmount: 150, paymentMethod: 'cash', relatedExpenseId: '', note: '分次還款第 3 筆', version: 1, createdAt: now, updatedAt: now }
      ],
      Taxes: [
        { id: 'tax_narita_1', tripId, dateTime: '2026-11-12T11:00', title: '成田機場第2航廈合併退稅單 (案例C/多店退稅)', refundType: 'post_refund', status: 'refunded', currency: 'JPY', totalRefundOriginal: 1600, exchangeRate: 0.22, totalRefundTwd: 352, receiverMemberId: 'mem_a', allocationMode: 'proportional_auto', receiptImageData: '', note: '合併松本清(10,000 JPY)與唐吉訶德(6,000 JPY)退稅', version: 1, createdAt: now, updatedAt: now }
      ],
      TaxExpenseLinks: [
        { id: 'tl_1', taxId: 'tax_narita_1', expenseId: 'exp_case_c1', tripId, merchantName: '松本清 銀座旗艦店', eligibleSubtotalOriginal: 10000, allocatedRefundOriginal: 1000, allocatedRefundTwd: 220, isEstimated: true, version: 1, createdAt: now, updatedAt: now },
        { id: 'tl_2', taxId: 'tax_narita_1', expenseId: 'exp_case_c2', tripId, merchantName: '唐吉訶德 澀谷店', eligibleSubtotalOriginal: 6000, allocatedRefundOriginal: 600, allocatedRefundTwd: 132, isEstimated: true, version: 1, createdAt: now, updatedAt: now }
      ],
      TaxItemAllocations: [],
      Settlements: []
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
