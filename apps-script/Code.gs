const SHEETS_SCHEMA = {
  Trips: ['id', 'name', 'baseCurrency', 'startDate', 'endDate', 'status', 'version', 'createdAt', 'updatedAt'],
  Members: ['id', 'tripId', 'name', 'avatarColor', 'note', 'isActive', 'version', 'createdAt', 'updatedAt'],
  Expenses: ['id', 'tripId', 'dateTime', 'merchantName', 'payerMemberId', 'paymentMethod', 'cardNote', 'transitCardName', 'currency', 'originalAmount', 'exchangeRate', 'twdAmount', 'discountOriginal', 'taxOriginal', 'feeOriginal', 'receiptImageData', 'note', 'version', 'createdAt', 'updatedAt'],
  ExpenseItems: ['id', 'expenseId', 'tripId', 'originalName', 'zhName', 'quantity', 'unitPriceOriginal', 'subtotalOriginal', 'allocatedTwd', 'isTaxRefundEligible', 'uncertain', 'version', 'createdAt', 'updatedAt'],
  Allocations: ['id', 'expenseId', 'expenseItemId', 'tripId', 'memberId', 'splitType', 'allocatedQty', 'allocatedOriginal', 'allocatedTwd', 'version', 'createdAt', 'updatedAt'],
  Payments: ['id', 'tripId', 'dateTime', 'fromMemberId', 'toMemberId', 'currency', 'originalAmount', 'exchangeRate', 'twdAmount', 'paymentMethod', 'relatedExpenseId', 'note', 'version', 'createdAt', 'updatedAt'],
  Taxes: ['id', 'tripId', 'dateTime', 'title', 'refundType', 'status', 'currency', 'totalRefundOriginal', 'exchangeRate', 'totalRefundTwd', 'receiverMemberId', 'allocationMode', 'receiptImageData', 'note', 'version', 'createdAt', 'updatedAt'],
  TaxExpenseLinks: ['id', 'taxId', 'expenseId', 'tripId', 'merchantName', 'eligibleSubtotalOriginal', 'allocatedRefundOriginal', 'allocatedRefundTwd', 'isEstimated', 'version', 'createdAt', 'updatedAt'],
  TaxItemAllocations: ['id', 'taxId', 'taxExpenseLinkId', 'expenseId', 'expenseItemId', 'memberId', 'tripId', 'refundOriginal', 'refundTwd', 'isManualOverride', 'version', 'createdAt', 'updatedAt'],
  Settlements: ['id', 'tripId', 'fromMemberId', 'toMemberId', 'twdAmount', 'status', 'confirmedAt', 'note', 'version', 'createdAt', 'updatedAt'],
  ExchangeRates: ['id', 'tripId', 'fromCurrency', 'toCurrency', 'rate', 'source', 'updatedAt'],
  Settings: ['key', 'value', 'updatedAt'],
  AuditLogs: ['id', 'tripId', 'entityType', 'entityId', 'action', 'idempotencyKey', 'summary', 'createdAt']
};

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
    const payload = JSON.parse(e.postData.contents || '{}');
    const props = PropertiesService.getScriptProperties();
    const secret = props.getProperty('GAS_SHARED_SECRET');
    if (secret && payload.secret !== secret) return jsonResponse({ ok: false, error: 'UNAUTHORIZED', message: '試算表通行密鑰驗證失敗' });
    const action = payload.action;
    if (action === 'ocr') return jsonResponse(handleOcrRequest(payload, props));
    ensureAllSheets();
    if (action === 'ping') return jsonResponse({ ok: true, timestamp: new Date().toISOString() });
    if (action === 'readAll') return jsonResponse({ ok: true, data: readAllTables(payload.tripId || null) });
    if (action === 'syncBatch') return jsonResponse({ ok: true, ...processSyncBatch(payload.operations || [], payload.idempotencyKey || '') });
    if (action === 'restoreFull') return jsonResponse({ ok: true, ...restoreFullDatabase(payload.data || {}, payload.idempotencyKey || '') });
    return jsonResponse({ ok: false, message: '不支援的操作: ' + action });
  } catch (err) {
    return jsonResponse({ ok: false, message: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function doGet() { return jsonResponse({ ok: true, service: 'Travel Wallet GAS Backend' }); }
function jsonResponse(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }

function handleOcrRequest(payload, props) {
  const { imageBase64, mode = 'receipt', provider = 'auto' } = payload;
  const geminiKey = props.getProperty('GEMINI_API_KEY') || '';
  const openaiKey = props.getProperty('OPENAI_API_KEY') || '';
  let selected = provider;
  if (selected === 'auto') selected = geminiKey ? 'gemini' : (openaiKey ? 'openai' : '');
  if (!selected) return { ok: false, message: 'GAS 指令碼屬性尚未設定 GEMINI_API_KEY 或 OPENAI_API_KEY' };

  const receiptPrompt = '你是精準的多國語言收據財務辨識助理。請分析收據並輸出純 JSON（無 markdown）。辨識店家(merchantName)、日期時間(dateTime: YYYY-MM-DDTHH:mm)、幣別(currency)、折扣(discountOriginal)、稅額(taxOriginal)、手續費(feeOriginal)、總額(totalOriginal)、模糊標記(overallUncertain: boolean)，以及逐項商品 items: [{"originalName": string, "zhName": "繁體中文翻譯", "quantity": number|null, "unitPriceOriginal": number|null, "subtotalOriginal": number|null, "isTaxRefundEligible": boolean, "uncertain": boolean, "uncertainReason": string}]。不確定欄位設 null 並標 uncertain: true，不可猜測，不可指定旅伴。';
  const taxPrompt = '你是精準的退稅單辨識助理。請分析退稅單並輸出純 JSON：{"title": string|null, "dateTime": string|null, "currency": string|null, "totalRefundOriginal": number|null, "uncertain": boolean, "notes": string}。模糊欄位設 null 不可猜測。';
  const sysPrompt = mode === 'tax' ? taxPrompt : receiptPrompt;

  if (selected === 'gemini') {
    const match = imageBase64.match(/^data:(.+?);base64,(.+)$/);
    const mimeType = match ? match[1] : 'image/jpeg';
    const rawBase64 = match ? match[2] : imageBase64;
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=' + encodeURIComponent(geminiKey);
    const res = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      payload: JSON.stringify({
        systemInstruction: { parts: [{ text: sysPrompt }] },
        contents: [{ role: 'user', parts: [{ text: '請辨識此圖片並輸出純 JSON' }, { inlineData: { mimeType: mimeType, data: rawBase64 } }] }],
        generationConfig: { temperature: 0.1, responseMimeType: 'application/json' }
      })
    });
    const json = JSON.parse(res.getContentText());
    if (res.getResponseCode() >= 400) return { ok: false, message: json.error?.message || 'Gemini 辨識失敗' };
    const textOut = json.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    return { ok: true, providerUsed: 'gemini', result: JSON.parse(textOut.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim()) };
  } else {
    const res = UrlFetchApp.fetch('https://api.openai.com/v1/chat/completions', {
      method: 'post', contentType: 'application/json', headers: { Authorization: 'Bearer ' + openaiKey }, muteHttpExceptions: true,
      payload: JSON.stringify({
        model: 'gpt-4o-mini', temperature: 0.1, response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: sysPrompt }, { role: 'user', content: [{ type: 'text', text: '請辨識此圖片並輸出純 JSON' }, { type: 'image_url', image_url: { url: imageBase64, detail: 'high' } }] }]
      })
    });
    const json = JSON.parse(res.getContentText());
    if (res.getResponseCode() >= 400) return { ok: false, message: json.error?.message || 'OpenAI 辨識失敗' };
    return { ok: true, providerUsed: 'openai', result: JSON.parse(json.choices?.[0]?.message?.content || '{}') };
  }
}

function ensureAllSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(SHEETS_SCHEMA).forEach(name => {
    let sheet = ss.getSheetByName(name);
    const headers = SHEETS_SCHEMA[name];
    if (!sheet) {
      sheet = ss.insertSheet(name);
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#EFE7DC');
      sheet.setFrozenRows(1);
    }
  });
}

function readAllTables() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const result = {};
  Object.keys(SHEETS_SCHEMA).forEach(name => {
    const sheet = ss.getSheetByName(name);
    if (!sheet || sheet.getLastRow() <= 1) { result[name] = []; return; }
    const headers = SHEETS_SCHEMA[name];
    const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues();
    result[name] = rows.map(row => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = row[i] instanceof Date ? row[i].toISOString() : row[i]; });
      return obj;
    });
  });
  return result;
}

function processSyncBatch(operations, idempotencyKey) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const auditSheet = ss.getSheetByName('AuditLogs');
  if (idempotencyKey && auditSheet && auditSheet.getLastRow() > 1) {
    const logs = auditSheet.getRange(2, 1, auditSheet.getLastRow() - 1, 8).getValues();
    if (logs.some(r => r[5] === idempotencyKey)) return { duplicateSkipped: true, applied: 0, conflicts: [] };
  }
  let applied = 0;
  const conflicts = [];
  const now = new Date().toISOString();
  operations.forEach(op => {
    const { table, type, record, id, expectedVersion } = op;
    if (!SHEETS_SCHEMA[table]) return;
    const sheet = ss.getSheetByName(table);
    const headers = SHEETS_SCHEMA[table];
    const lastRow = sheet.getLastRow();
    let targetRow = -1, existingRow = null;
    if (lastRow > 1) {
      const data = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
      const targetId = type === 'delete' ? id : record[headers[0]];
      for (let i = 0; i < data.length; i++) {
        if (String(data[i][0]) === String(targetId)) { targetRow = i + 2; existingRow = data[i]; break; }
      }
    }
    if (type === 'upsert') {
      const vIdx = headers.indexOf('version');
      if (existingRow && vIdx !== -1 && expectedVersion != null && Number(existingRow[vIdx] || 1) !== Number(expectedVersion)) {
        conflicts.push({ table, id: record.id, clientVersion: expectedVersion, serverVersion: Number(existingRow[vIdx]) });
        return;
      }
      const nextVer = existingRow && vIdx !== -1 ? Number(existingRow[vIdx] || 1) + 1 : 1;
      const rowValues = headers.map((h, idx) => h === 'version' ? nextVer : h === 'updatedAt' ? now : h === 'createdAt' ? (existingRow ? existingRow[idx] : (record.createdAt || now)) : (record[h] ?? ''));
      if (targetRow > 0) sheet.getRange(targetRow, 1, 1, headers.length).setValues([rowValues]);
      else sheet.appendRow(rowValues);
      applied++;
    } else if (type === 'delete' && targetRow > 0) {
      sheet.deleteRow(targetRow);
      applied++;
    }
  });
  if (idempotencyKey && auditSheet) auditSheet.appendRow(['log_' + Utilities.getUuid().slice(0, 8), '', 'BATCH', '', 'SYNC', idempotencyKey, 'Applied ' + applied, now]);
  return { duplicateSkipped: false, applied, conflicts };
}

function restoreFullDatabase(data) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(SHEETS_SCHEMA).forEach(table => {
    if (table === 'AuditLogs') return;
    const sheet = ss.getSheetByName(table);
    const headers = SHEETS_SCHEMA[table];
    if (sheet.getLastRow() > 1) sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).clearContent();
    const rows = data[table] || [];
    if (rows.length > 0) sheet.getRange(2, 1, rows.length, headers.length).setValues(rows.map(rec => headers.map(h => rec[h] ?? '')));
  });
  return { restored: true };
}
