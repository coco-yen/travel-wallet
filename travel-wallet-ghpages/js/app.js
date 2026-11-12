window.AppUI = (function () {
  const Store = window.TravelStore, Engine = window.TravelEngine, Exporter = window.TravelExporter;
  let draftItems = [], currentReceiptBase64 = '', currentTaxReceiptBase64 = '';

  function fmt(n) { return Number(n || 0).toLocaleString('zh-TW', { maximumFractionDigits: 2 }); }
  function nowLocalInput() { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); }

  function getTripScopedData() {
    const full = Store.getState(), tripId = Store.getActiveTripId();
    return {
      tripId, Trip: full.Trips.find(t => t.id === tripId) || null, Trips: full.Trips,
      Members: full.Members.filter(m => m.tripId === tripId),
      Expenses: full.Expenses.filter(e => e.tripId === tripId),
      ExpenseItems: full.ExpenseItems.filter(i => i.tripId === tripId),
      Allocations: full.Allocations.filter(a => a.tripId === tripId),
      Payments: full.Payments.filter(p => p.tripId === tripId),
      Taxes: full.Taxes.filter(t => t.tripId === tripId),
      TaxExpenseLinks: full.TaxExpenseLinks.filter(l => l.tripId === tripId),
      TaxItemAllocations: full.TaxItemAllocations.filter(a => a.tripId === tripId),
      Settlements: full.Settlements.filter(s => s.tripId === tripId)
    };
  }

  function switchTab(tabName) {
    document.querySelectorAll('.nav-tab').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tabName));
    document.querySelectorAll('.page-section').forEach(sec => sec.classList.toggle('active', sec.id === `tab-${tabName}`));
    renderAll();
  }

  function populateCurrencySelect(el, selected = 'JPY') {
    if (!el) return;
    const prev = el.value || selected;
    el.innerHTML = Store.DEFAULT_CURRENCIES.map(c => `<option value="${c.code}" ${c.code === prev ? 'selected' : ''}>${c.code} (${c.name})</option>`).join('');
  }

  function populateMemberSelect(el, members, includeEmpty = false, emptyLabel = '全部') {
    if (!el) return;
    const prev = el.value;
    el.innerHTML = (includeEmpty ? `<option value="">${emptyLabel}</option>` : '') + members.map(m => `<option value="${m.id}" ${m.id === prev ? 'selected' : ''}>${m.name}</option>`).join('');
  }

  function renderAll() {
    const data = getTripScopedData(), sync = Store.getSyncStatus(), settlement = Engine.calculateTripSettlement(data);
    document.getElementById('activeTripSelect').innerHTML = data.Trips.map(t => `<option value="${t.id}" ${t.id === data.tripId ? 'selected' : ''}>${t.name}</option>`).join('');
    document.getElementById('syncStatusText').textContent = sync.message;
    renderOverview(data, settlement);
    renderExpensesList(data, settlement);
    renderExpenseFormContext(data);
    renderPaymentsPage(data);
    renderTaxesPage(data, settlement);
    renderSettlementPage(data, settlement);
    renderSettingsPage(data, sync);
  }

  function renderOverview(data, settlement) {
    const totalTwd = settlement.expenseBreakdowns.reduce((s, b) => s + b.finalTwd, 0);
    const totalTaxTwd = settlement.taxBreakdowns.filter(t => ['confirmed', 'processing', 'refunded'].includes(t.status)).reduce((s, t) => s + t.totalRefundTwd, 0);
    const totalReceivable = settlement.summaries.filter(m => m.netBalanceTwd > 0).reduce((s, m) => s + m.netBalanceTwd, 0);
    const allWarnings = [...settlement.expenseBreakdowns.flatMap(b => b.warnings), ...settlement.taxBreakdowns.flatMap(t => t.warnings)];

    document.getElementById('globalAlerts').innerHTML = allWarnings.length > 0
      ? `<div class="alert-box"><strong>帳務提醒 (${allWarnings.length})：</strong><ul style="margin:6px 0 0 18px;">${allWarnings.map(w => `<li>${w}</li>`).join('')}</ul></div>` : '';

    document.getElementById('overviewKpis').innerHTML = `
      <div class="kpi-card"><div class="kpi-label">旅程總消費支出 (TWD)</div><div class="kpi-value">NT$ ${fmt(totalTwd)}</div><div class="kpi-sub">共 ${data.Expenses.length} 筆消費紀錄</div></div>
      <div class="kpi-card"><div class="kpi-label">已確認退稅總額 (TWD)</div><div class="kpi-value">NT$ ${fmt(totalTaxTwd)}</div><div class="kpi-sub">已折抵各商品分帳</div></div>
      <div class="kpi-card"><div class="kpi-label">待結算轉帳總額 (TWD)</div><div class="kpi-value">NT$ ${fmt(totalReceivable)}</div><div class="kpi-sub">最佳化建議 ${settlement.suggestedTransfers.length} 筆轉帳</div></div>
      <div class="kpi-card"><div class="kpi-label">旅伴人數</div><div class="kpi-value">${data.Members.length} 人</div><div class="kpi-sub">${data.Trip ? data.Trip.name : ''}</div></div>
    `;

    const byCurr = {};
    data.Expenses.forEach(e => { const c = e.currency || 'TWD'; if (!byCurr[c]) byCurr[c] = { orig: 0, twd: 0 }; byCurr[c].orig += Number(e.originalAmount || 0); byCurr[c].twd += Number(e.twdAmount || 0); });
    document.getElementById('currencyBreakdownBody').innerHTML = Object.entries(byCurr).map(([c, v]) => `<tr><td><span class="badge">${c}</span></td><td class="num">${fmt(v.orig)}</td><td class="num">NT$ ${fmt(v.twd)}</td></tr>`).join('') || '<tr><td colspan="3">尚無資料</td></tr>';
    document.getElementById('overviewMemberBody').innerHTML = settlement.summaries.map(m => `<tr><td><strong>${m.name}</strong></td><td class="num">NT$ ${fmt(m.netShareTwd)}</td><td class="num">NT$ ${fmt(m.totalContributionTwd)}</td><td class="num ${m.netBalanceTwd >= 0 ? 'pos-amt' : 'neg-amt'}">${m.netBalanceTwd >= 0 ? '+應收 ' : '-應付 '}NT$ ${fmt(Math.abs(m.netBalanceTwd))}</td></tr>`).join('');
  }

  function renderExpensesList(data, settlement) {
    populateMemberSelect(document.getElementById('filterPayer'), data.Members, true, '全部付款人');
    const kw = (document.getElementById('filterKeyword').value || '').toLowerCase(), payer = document.getElementById('filterPayer').value, method = document.getElementById('filterMethod').value;
    const memberMap = Object.fromEntries(data.Members.map(m => [m.id, m.name])), methodLabel = { credit_card: '信用卡', cash: '現金', transit_card: '交通卡' };
    const filtered = data.Expenses.filter(e => {
      if (payer && e.payerMemberId !== payer) return false;
      if (method && e.paymentMethod !== method) return false;
      if (kw) {
        const expItems = data.ExpenseItems.filter(i => i.expenseId === e.id);
        if (![e.merchantName, e.note, ...expItems.map(i => i.zhName + i.originalName)].join(' ').toLowerCase().includes(kw)) return false;
      }
      return true;
    }).sort((a, b) => (b.dateTime || '').localeCompare(a.dateTime || ''));

    document.getElementById('expensesTableBody').innerHTML = filtered.map(e => {
      const bd = settlement.expenseBreakdowns.find(b => b.expenseId === e.id);
      const warnBadge = bd && bd.warnings.length > 0 ? `<span class="badge badge-warn">需確認分帳</span>` : '';
      return `<tr><td>${(e.dateTime || '').replace('T', ' ')}</td><td><strong>${e.merchantName}</strong> ${warnBadge}<div style="font-size:0.78rem;color:var(--brown-light);">${e.note || ''}</div></td><td>${memberMap[e.payerMemberId] || e.payerMemberId}</td><td><span class="badge badge-brown">${methodLabel[e.paymentMethod] || e.paymentMethod}</span> ${e.cardNote || e.transitCardName || ''}</td><td class="num">${e.currency} ${fmt(e.originalAmount)}</td><td class="num">NT$ ${fmt(e.twdAmount)}</td><td><button class="btn btn-secondary btn-sm" onclick="window.AppUI.editExpense('${e.id}')">編輯</button> <button class="btn btn-danger btn-sm" onclick="window.AppUI.deleteExpense('${e.id}')">刪除</button></td></tr>`;
    }).join('') || '<tr><td colspan="7">尚無符合條件的消費紀錄</td></tr>';
  }

  function renderExpenseFormContext(data) {
    populateMemberSelect(document.getElementById('expPayer'), data.Members);
    populateCurrencySelect(document.getElementById('expCurrency'), 'JPY');
    renderDraftItems(data.Members);
  }

  function renderDraftItems(members) {
    const container = document.getElementById('expenseItemsContainer');
    if (draftItems.length === 0) { container.innerHTML = '<div class="alert-box">尚未新增商品品項，請點擊「+ 新增商品品項」或使用 AI 收據辨識。</div>'; return; }
    container.innerHTML = draftItems.map((item, idx) => {
      const uncertainTag = item.uncertain ? `<span class="badge badge-danger">待確認：${item.uncertainReason || '欄位模糊，請對照收據修改'}</span>` : '';
      return `
        <div class="item-box">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
            <strong>品項 #${idx + 1} ${uncertainTag}</strong>
            <div style="display:flex;gap:8px;align-items:center;">
              <label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;"><input type="checkbox" ${item.isTaxRefundEligible ? 'checked' : ''} onchange="window.AppUI.updateDraftItem(${idx}, 'isTaxRefundEligible', this.checked)" /> 符合退稅資格</label>
              <button type="button" class="btn btn-danger btn-sm" onclick="window.AppUI.removeDraftItem(${idx})">移除</button>
            </div>
          </div>
          <div class="form-grid">
            <div class="form-group"><label>商品原文名稱（可修改）</label><input type="text" value="${item.originalName || ''}" onchange="window.AppUI.updateDraftItem(${idx}, 'originalName', this.value)" /></div>
            <div class="form-group"><label>繁體中文名稱（可修改） *</label><input type="text" value="${item.zhName || ''}" onchange="window.AppUI.updateDraftItem(${idx}, 'zhName', this.value)" required /></div>
            <div class="form-group"><label>購買數量（可修改）</label><input type="number" step="0.01" value="${item.quantity ?? 1}" onchange="window.AppUI.updateDraftItem(${idx}, 'quantity', Number(this.value))" /></div>
            <div class="form-group"><label>原幣單價（可修改）</label><input type="number" step="0.01" value="${item.unitPriceOriginal ?? 0}" onchange="window.AppUI.updateDraftItem(${idx}, 'unitPriceOriginal', Number(this.value))" /></div>
            <div class="form-group"><label>原幣小計（可修改） *</label><input type="number" step="0.01" value="${item.subtotalOriginal ?? 0}" onchange="window.AppUI.updateDraftItem(${idx}, 'subtotalOriginal', Number(this.value))" /></div>
            <div class="form-group"><label>分帳方式</label>
              <select onchange="window.AppUI.changeItemSplitMode(${idx}, this.value)">
                <option value="equal" ${item.splitMode === 'equal' ? 'selected' : ''}>勾選旅伴均分</option>
                <option value="quantity" ${item.splitMode === 'quantity' ? 'selected' : ''}>依購買數量拆分 (如 3 盒拆 1 與 2)</option>
                <option value="amount" ${item.splitMode === 'amount' ? 'selected' : ''}>依自訂原幣金額拆分</option>
              </select>
            </div>
          </div>
          <div class="member-chips">
            ${members.map(m => {
              const alloc = (item.allocations || []).find(a => a.memberId === m.id);
              if (item.splitMode === 'equal') return `<label class="member-chip"><input type="checkbox" ${alloc ? 'checked' : ''} onchange="window.AppUI.toggleItemMemberEqual(${idx}, '${m.id}', this.checked)" /> ${m.name}</label>`;
              if (item.splitMode === 'quantity') return `<div class="member-chip"><span>${m.name} 數量:</span><input type="number" step="0.5" min="0" style="width:65px;padding:4px;" value="${alloc ? alloc.allocatedQty : 0}" onchange="window.AppUI.setItemMemberValue(${idx}, '${m.id}', 'quantity', Number(this.value))" /></div>`;
              return `<div class="member-chip"><span>${m.name} 原幣:</span><input type="number" step="0.01" min="0" style="width:80px;padding:4px;" value="${alloc ? alloc.allocatedOriginal : 0}" onchange="window.AppUI.setItemMemberValue(${idx}, '${m.id}', 'amount', Number(this.value))" /></div>`;
            }).join('')}
          </div>
        </div>
      `;
    }).join('');
  }

  function renderPaymentsPage(data) {
    populateMemberSelect(document.getElementById('payFromMember'), data.Members);
    populateMemberSelect(document.getElementById('payToMember'), data.Members);
    populateCurrencySelect(document.getElementById('payCurrency'), 'JPY');
    document.getElementById('payRelatedExpense').innerHTML = '<option value="">不指定單筆</option>' + data.Expenses.map(e => `<option value="${e.id}">${e.dateTime.slice(0, 10)} ${e.merchantName}</option>`).join('');
    const memberMap = Object.fromEntries(data.Members.map(m => [m.id, m.name])), methodLabel = { cash: '現金', bank_transfer: '銀行轉帳', other: '其他' };
    document.getElementById('paymentsTableBody').innerHTML = data.Payments.slice().sort((a, b) => (b.dateTime || '').localeCompare(a.dateTime || '')).map(p =>
      `<tr><td>${(p.dateTime || '').replace('T', ' ')}</td><td><strong>${memberMap[p.fromMemberId] || p.fromMemberId}</strong></td><td><strong>${memberMap[p.toMemberId] || p.toMemberId}</strong></td><td><span class="badge badge-brown">${methodLabel[p.paymentMethod] || p.paymentMethod}</span></td><td class="num">${p.currency} ${fmt(p.originalAmount)}</td><td class="num">NT$ ${fmt(p.twdAmount)}</td><td>${p.note || ''}</td><td><button class="btn btn-danger btn-sm" onclick="window.AppUI.deletePayment('${p.id}')">刪除</button></td></tr>`
    ).join('') || '<tr><td colspan="8">尚無收付款紀錄</td></tr>';
  }

  function renderTaxesPage(data, settlement) {
    populateCurrencySelect(document.getElementById('taxCurrency'), 'JPY');
    populateMemberSelect(document.getElementById('taxReceiverMember'), data.Members);
    const memberMap = Object.fromEntries(data.Members.map(m => [m.id, m.name]));
    document.getElementById('taxReceiptsSelector').innerHTML = data.Expenses.map(exp => {
      const expItems = data.ExpenseItems.filter(i => i.expenseId === exp.id);
      return `<div class="item-box" style="padding:10px 14px;">
        <div style="display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px;">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;"><input type="checkbox" class="tax-exp-check" data-exp-id="${exp.id}" /> <strong>${exp.merchantName}</strong> (${exp.dateTime.slice(0, 10)} · ${exp.currency} ${fmt(exp.originalAmount)})</label>
          <div><span style="font-size:0.8rem;">此店實際退稅原幣:</span> <input type="number" step="0.01" class="tax-exp-manual-orig" data-exp-id="${exp.id}" placeholder="自動估算" style="width:105px;padding:4px;" /></div>
        </div>
        <div style="margin-top:6px;padding-left:22px;">${expItems.map(it => `<label style="display:flex;align-items:center;gap:6px;font-size:0.84rem;"><input type="checkbox" class="tax-item-check" data-exp-id="${exp.id}" data-item-id="${it.id}" data-orig="${it.subtotalOriginal}" ${it.isTaxRefundEligible ? 'checked' : ''} /> ${it.zhName || it.originalName} (${exp.currency} ${fmt(it.subtotalOriginal)})</label>`).join('')}</div>
      </div>`;
    }).join('');
    const statusMap = { pending_match: '待配對', pending_confirm: '待確認', confirmed: '已確認', processing: '退款處理中', refunded: '已退款' };
    document.getElementById('taxesListContainer').innerHTML = data.Taxes.map(tax => {
      const bd = settlement.taxBreakdowns.find(b => b.taxId === tax.id);
      return `<div class="item-box">
        <div style="display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px;">
          <div><strong>${tax.title}</strong> <span class="badge">${statusMap[tax.status] || tax.status}</span></div>
          <div><strong>退稅總額：${tax.currency} ${fmt(tax.totalRefundOriginal)} (NT$ ${fmt(tax.totalRefundTwd)})</strong> · 收款人：<strong>${memberMap[tax.receiverMemberId] || tax.receiverMemberId}</strong> <button class="btn btn-danger btn-sm" onclick="window.AppUI.deleteTax('${tax.id}')">刪除</button></div>
        </div>
        <div style="margin-top:6px;font-size:0.84rem;color:var(--caramel-dark);"><strong>旅伴退稅折抵：</strong>${Object.entries(bd?.memberRefundTwd || {}).map(([mId, amt]) => `${memberMap[mId] || mId}: NT$ ${fmt(amt)}`).join('、') || '無'}</div>
      </div>`;
    }).join('') || '<p>尚無退稅紀錄。</p>';
  }

  function renderSettlementPage(data, settlement) {
    const transfersBox = document.getElementById('suggestedTransfersContainer');
    transfersBox.innerHTML = settlement.suggestedTransfers.length === 0
      ? '<div class="item-box">目前所有旅伴帳務已完全平衡！</div>'
      : settlement.suggestedTransfers.map(tr => `<div class="item-box" style="display:flex;justify-content:space-between;align-items:center;"><div><strong>${tr.fromName}</strong> 應轉帳給 <strong>${tr.toName}</strong> <span class="pos-amt" style="margin-left:10px;">NT$ ${fmt(tr.twdAmount)}</span></div><button class="btn btn-primary btn-sm" onclick="window.AppUI.confirmSettlementTransfer('${tr.fromMemberId}', '${tr.toMemberId}', ${tr.twdAmount})">確認完成轉帳</button></div>`).join('');

    document.getElementById('settlementTableBody').innerHTML = settlement.summaries.map(s => `<tr><td><strong>${s.name}</strong></td><td class="num">NT$ ${fmt(s.paidForExpensesTwd)}</td><td class="num">NT$ ${fmt(s.transfersSentTwd)}</td><td class="num">NT$ ${fmt(s.transfersReceivedTwd)}</td><td class="num">NT$ ${fmt(s.taxRefundReceivedTwd)}</td><td class="num">NT$ ${fmt(s.grossShareTwd)}</td><td class="num">NT$ ${fmt(s.taxRefundBenefitTwd)}</td><td class="num ${s.netBalanceTwd >= 0 ? 'pos-amt' : 'neg-amt'}">${s.netBalanceTwd >= 0 ? '+應收 ' : '-應付 '}NT$ ${fmt(Math.abs(s.netBalanceTwd))}</td><td><button class="btn btn-secondary btn-sm" onclick="window.AppUI.showMemberTrace('${s.memberId}')">明細追溯</button></td></tr>`).join('');
  }

  function renderSettingsPage(data, sync) {
    const creds = Store.getUserCredentials();
    if (document.getElementById('credGasUrl') && document.activeElement?.id !== 'credGasUrl') {
      document.getElementById('credGasUrl').value = creds.gasUrl || '';
      document.getElementById('credGasSecret').value = creds.gasSecret || '';
      document.getElementById('credGeminiKey').value = creds.userGeminiKey || '';
      document.getElementById('credOpenAIKey').value = creds.userOpenAIKey || '';
    }

    document.getElementById('membersListContainer').innerHTML = data.Members.map(m => `<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--bg-beige);"><div><strong>${m.name}</strong> <span style="font-size:0.8rem;color:var(--brown-light);">${m.note || ''}</span></div><button class="btn btn-danger btn-sm" onclick="window.AppUI.deleteMember('${m.id}')">移除</button></div>`).join('');

    document.getElementById('apiDiagnosticBox').innerHTML = `
      <strong>目前瀏覽器工作階段的安全連線狀態：</strong>
      <ul style="margin:6px 0 0 18px;font-size:0.86rem;">
        <li>託管模式：<strong>GitHub Pages 純靜態前端（零暴露金鑰）</strong></li>
        <li>Google Sheets 中央資料庫：<strong>${Store.hasGasConfigured() ? '已設定 Google Apps Script 網址' : '未設定（目前為本機瀏覽器暫存模式）'}</strong></li>
        <li>Google Gemini 收據辨識：<strong>${creds.userGeminiKey ? '已設定您的個人 Gemini Key' : (Store.hasGasConfigured() ? '若 GAS 後端有設定 Key 亦可直接使用' : '尚未設定（請填入個人 Gemini Key）')}</strong></li>
        <li>OpenAI Vision 收據辨識：<strong>${creds.userOpenAIKey ? '已設定您的個人 OpenAI Key' : '尚未設定'}</strong></li>
      </ul>
    `;
  }

  function openNewExpense() {
    document.getElementById('expenseForm').reset();
    document.getElementById('expId').value = '';
    document.getElementById('expDateTime').value = nowLocalInput();
    document.getElementById('expenseFormTitle').textContent = '新增消費與品項分帳';
    currentReceiptBase64 = '';
    document.getElementById('receiptPreviewBox').style.display = 'none';
    document.getElementById('receiptOcrReviewBanner').style.display = 'none';
    const members = getTripScopedData().Members;
    draftItems = [{ id: Store.genId('itm'), originalName: '', zhName: '', quantity: 1, unitPriceOriginal: 0, subtotalOriginal: 0, isTaxRefundEligible: false, splitMode: 'equal', allocations: members.map(m => ({ memberId: m.id, splitType: 'equal', allocatedQty: 1, allocatedOriginal: 0 })) }];
    switchTab('add-expense');
  }

  function editExpense(expenseId) {
    const data = getTripScopedData(), exp = data.Expenses.find(e => e.id === expenseId);
    if (!exp) return;
    document.getElementById('expId').value = exp.id;
    document.getElementById('expDateTime').value = exp.dateTime;
    document.getElementById('expMerchant').value = exp.merchantName;
    document.getElementById('expPayer').value = exp.payerMemberId;
    document.getElementById('expMethod').value = exp.paymentMethod;
    document.getElementById('expCardNote').value = exp.cardNote || '';
    document.getElementById('expTransitName').value = exp.transitCardName || '';
    document.getElementById('expCurrency').value = exp.currency;
    document.getElementById('expOriginalAmount').value = exp.originalAmount;
    document.getElementById('expExchangeRate').value = exp.exchangeRate;
    document.getElementById('expTwdAmount').value = exp.twdAmount;
    document.getElementById('expDiscount').value = exp.discountOriginal || 0;
    document.getElementById('expTaxFee').value = Number(exp.taxOriginal || 0) + Number(exp.feeOriginal || 0);
    document.getElementById('expNote').value = exp.note || '';
    document.getElementById('expenseFormTitle').textContent = `編輯消費：${exp.merchantName}`;
    draftItems = data.ExpenseItems.filter(i => i.expenseId === exp.id).map(it => {
      const itAllocs = data.Allocations.filter(a => a.expenseItemId === it.id);
      const mode = itAllocs[0]?.splitType === 'quantity' ? 'quantity' : itAllocs[0]?.splitType === 'amount' ? 'amount' : 'equal';
      return { ...it, splitMode: mode, allocations: itAllocs };
    });
    switchTab('add-expense');
  }

  function deleteExpense(id) {
    if (!confirm('確定刪除此筆消費？')) return;
    const data = getTripScopedData();
    Store.mutate([{ table: 'Expenses', type: 'delete', id }, ...data.ExpenseItems.filter(i => i.expenseId === id).map(i => ({ table: 'ExpenseItems', type: 'delete', id: i.id })), ...data.Allocations.filter(a => a.expenseId === id).map(a => ({ table: 'Allocations', type: 'delete', id: a.id }))]);
  }

  function updateDraftItem(idx, field, val) {
    draftItems[idx][field] = val;
    if (field === 'quantity' || field === 'unitPriceOriginal') {
      const q = Number(draftItems[idx].quantity || 0), p = Number(draftItems[idx].unitPriceOriginal || 0);
      if (q > 0 && p > 0) draftItems[idx].subtotalOriginal = Engine.roundAmount(q * p, 2);
    }
    if (field === 'zhName' || field === 'subtotalOriginal') draftItems[idx].uncertain = false;
    renderDraftItems(getTripScopedData().Members);
  }

  function removeDraftItem(idx) { draftItems.splice(idx, 1); renderDraftItems(getTripScopedData().Members); }
  function changeItemSplitMode(idx, mode) {
    const members = getTripScopedData().Members;
    draftItems[idx].splitMode = mode;
    draftItems[idx].allocations = mode === 'equal' ? members.map(m => ({ memberId: m.id, splitType: 'equal', allocatedQty: 1, allocatedOriginal: 0 })) : [];
    renderDraftItems(members);
  }
  function toggleItemMemberEqual(idx, memberId, checked) {
    const list = draftItems[idx].allocations || [];
    if (checked && !list.some(a => a.memberId === memberId)) list.push({ memberId, splitType: 'equal', allocatedQty: 1, allocatedOriginal: 0 });
    else if (!checked) draftItems[idx].allocations = list.filter(a => a.memberId !== memberId);
  }
  function setItemMemberValue(idx, memberId, mode, val) {
    const list = draftItems[idx].allocations || [], existing = list.find(a => a.memberId === memberId);
    if (val <= 0) { draftItems[idx].allocations = list.filter(a => a.memberId !== memberId); return; }
    if (existing) { existing.splitType = mode; if (mode === 'quantity') existing.allocatedQty = val; else existing.allocatedOriginal = val; }
    else list.push({ memberId, splitType: mode, allocatedQty: mode === 'quantity' ? val : 0, allocatedOriginal: mode === 'amount' ? val : 0 });
  }

  function fileToResizedBase64(file, maxDim = 1280) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(img.width * scale); canvas.height = Math.round(img.height * scale);
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', 0.85));
        };
        img.onerror = reject; img.src = reader.result;
      };
      reader.onerror = reject; reader.readAsDataURL(file);
    });
  }

  async function runReceiptOcr() {
    const fileInput = document.getElementById('receiptFileInput');
    if (!fileInput.files || !fileInput.files[0]) { alert('請先選擇或拍攝收據照片'); return; }
    const btn = document.getElementById('btnRunReceiptOcr');
    btn.disabled = true; btn.textContent = 'AI 辨識中...';
    try {
      currentReceiptBase64 = await fileToResizedBase64(fileInput.files[0]);
      const preview = document.getElementById('receiptPreviewBox');
      preview.style.display = 'block';
      preview.innerHTML = `<div style="font-size:0.82rem;color:var(--brown-mid);margin-bottom:4px;"><strong>收據原始照片對照（點擊可放大檢視）：</strong></div>
        <img src="${currentReceiptBase64}" onclick="window.open(this.src)" style="max-height:240px;cursor:zoom-in;border-radius:8px;border:1px solid var(--border-sand);" />`;

      const provider = document.getElementById('receiptAiProvider')?.value || 'auto';
      const json = await Store.runAiOcr({ imageBase64: currentReceiptBase64, mode: 'receipt', provider });

      const r = json.result;
      const usedLabel = json.providerUsed === 'gemini' ? 'Google Gemini' : 'OpenAI Vision';
      const banner = document.getElementById('receiptOcrReviewBanner');
      banner.style.display = 'block';
      banner.innerHTML = `<div class="alert-box" style="margin-bottom:0;">
        <strong>已完成辨識（引擎：${usedLabel}）</strong>｜
        ${r.overallUncertain ? '<span class="badge badge-danger">部分欄位較模糊，請對照下方收據原圖修改</span>' : '所有辨識欄位皆已填入下方表單，您可直接修改品名、數量、金額或新增漏抓品項，確認無誤後再按儲存。'}
      </div>`;

      if (r.merchantName) document.getElementById('expMerchant').value = r.merchantName;
      if (r.dateTime) document.getElementById('expDateTime').value = r.dateTime.slice(0, 16);
      if (r.currency) document.getElementById('expCurrency').value = r.currency;
      if (r.discountOriginal) document.getElementById('expDiscount').value = r.discountOriginal;
      document.getElementById('expTaxFee').value = Number(r.taxOriginal || 0) + Number(r.feeOriginal || 0);

      draftItems = (r.items || []).map(it => ({
        id: Store.genId('itm'),
        originalName: it.originalName || '',
        zhName: it.zhName || it.originalName || '待確認商品',
        quantity: it.quantity ?? 1,
        unitPriceOriginal: it.unitPriceOriginal ?? 0,
        subtotalOriginal: it.subtotalOriginal ?? 0,
        isTaxRefundEligible: Boolean(it.isTaxRefundEligible),
        uncertain: Boolean(it.uncertain),
        uncertainReason: it.uncertainReason || '',
        splitMode: 'equal',
        allocations: []
      }));

      if (r.totalOriginal) {
        document.getElementById('expOriginalAmount').value = r.totalOriginal;
        const rate = Number(document.getElementById('expExchangeRate').value || 1);
        document.getElementById('expTwdAmount').value = Engine.roundAmount(r.totalOriginal * rate, 0);
      }
      renderDraftItems(getTripScopedData().Members);
    } catch (err) {
      alert('AI 辨識提示：' + err.message);
    } finally {
      btn.disabled = false; btn.textContent = '開始 AI 辨識';
    }
  }

  async function runTaxOcr() {
    const fileInput = document.getElementById('taxFileInput');
    if (!fileInput.files || !fileInput.files[0]) { alert('請先選擇退稅單照片'); return; }
    const btn = document.getElementById('btnRunTaxOcr');
    btn.disabled = true; btn.textContent = '辨識中...';
    try {
      currentTaxReceiptBase64 = await fileToResizedBase64(fileInput.files[0]);
      const provider = document.getElementById('taxAiProvider')?.value || 'auto';
      const json = await Store.runAiOcr({ imageBase64: currentTaxReceiptBase64, mode: 'tax', provider });
      const r = json.result;
      if (r.title) document.getElementById('taxTitle').value = r.title;
      if (r.dateTime) document.getElementById('taxDateTime').value = r.dateTime.slice(0, 16);
      if (r.currency) document.getElementById('taxCurrency').value = r.currency;
      if (r.totalRefundOriginal) {
        document.getElementById('taxRefundOriginal').value = r.totalRefundOriginal;
        const rate = Number(document.getElementById('taxExchangeRate').value || 1);
        document.getElementById('taxRefundTwd').value = Engine.roundAmount(r.totalRefundOriginal * rate, 0);
      }
      alert('退稅單辨識完成，請確認並修改欄位後勾選關聯收據。');
    } catch (err) {
      alert('退稅單辨識提示：' + err.message);
    } finally {
      btn.disabled = false; btn.textContent = '辨識退稅單';
    }
  }

  function deletePayment(id) { if (confirm('確定刪除此筆收付款紀錄？')) Store.mutate([{ table: 'Payments', type: 'delete', id }]); }
  function deleteTax(id) {
    if (!confirm('確定刪除此筆退稅單？')) return;
    const data = getTripScopedData();
    Store.mutate([{ table: 'Taxes', type: 'delete', id }, ...data.TaxExpenseLinks.filter(l => l.taxId === id).map(l => ({ table: 'TaxExpenseLinks', type: 'delete', id: l.id })), ...data.TaxItemAllocations.filter(a => a.taxId === id).map(a => ({ table: 'TaxItemAllocations', type: 'delete', id: a.id }))]);
  }
  function confirmSettlementTransfer(fromId, toId, twdAmount) {
    Store.mutate([{ table: 'Payments', type: 'upsert', record: { id: Store.genId('pay'), tripId: Store.getActiveTripId(), dateTime: nowLocalInput(), fromMemberId: fromId, toMemberId: toId, currency: 'TWD', originalAmount: twdAmount, exchangeRate: 1, twdAmount, paymentMethod: 'bank_transfer', relatedExpenseId: '', note: '結算頁面確認完成轉帳' } }]);
  }
  function showMemberTrace(memberId) {
    const data = getTripScopedData(), settlement = Engine.calculateTripSettlement(data), m = settlement.summaries.find(s => s.memberId === memberId);
    if (!m) return;
    document.getElementById('memberTraceDrawer').innerHTML = `<div class="item-box"><div style="display:flex;justify-content:space-between;margin-bottom:8px;"><strong>${m.name} 的帳務追溯明細</strong><button class="btn btn-secondary btn-sm" onclick="document.getElementById('memberTraceDrawer').innerHTML=''">關閉</button></div><table><thead><tr><th>日期</th><th>說明</th><th class="num">金額 (TWD)</th></tr></thead><tbody>${m.traces.map(t => `<tr><td>${(t.dateTime || '').replace('T', ' ')}</td><td>${t.label}</td><td class="num ${t.amountTwd >= 0 ? 'pos-amt' : 'neg-amt'}">${t.amountTwd >= 0 ? '+' : ''}${fmt(t.amountTwd)}</td></tr>`).join('')}</tbody></table></div>`;
  }
  function deleteMember(id) { if (confirm('確定移除此旅伴？')) Store.mutate([{ table: 'Members', type: 'delete', id }]); }

  function initEvents() {
    document.getElementById('mainNav').addEventListener('click', e => { if (e.target.classList.contains('nav-tab')) switchTab(e.target.dataset.tab); });
    document.getElementById('activeTripSelect').addEventListener('change', e => Store.setActiveTripId(e.target.value));
    document.getElementById('btnManualSync').addEventListener('click', () => Store.pullFromCloud());
    ['filterKeyword', 'filterPayer', 'filterMethod'].forEach(id => document.getElementById(id).addEventListener('input', renderAll));

    document.getElementById('expMethod').addEventListener('change', e => {
      document.getElementById('cardNoteGroup').style.display = e.target.value === 'credit_card' ? 'flex' : 'none';
      document.getElementById('transitNoteGroup').style.display = e.target.value === 'transit_card' ? 'flex' : 'none';
    });

    ['expOriginalAmount', 'expExchangeRate'].forEach(id => {
      document.getElementById(id).addEventListener('input', () => {
        const orig = Number(document.getElementById('expOriginalAmount').value || 0), rate = Number(document.getElementById('expExchangeRate').value || 1);
        document.getElementById('expTwdAmount').value = Engine.roundAmount(orig * rate, 0);
      });
    });

    document.getElementById('btnRecalcTotalFromItems').addEventListener('click', () => {
      const sumOrig = draftItems.reduce((s, it) => s + Number(it.subtotalOriginal || 0), 0);
      const disc = Number(document.getElementById('expDiscount').value || 0), tf = Number(document.getElementById('expTaxFee').value || 0);
      const net = Engine.roundAmount(sumOrig - disc + tf, 2);
      document.getElementById('expOriginalAmount').value = net;
      const rate = Number(document.getElementById('expExchangeRate').value || 1);
      document.getElementById('expTwdAmount').value = Engine.roundAmount(net * rate, 0);
    });

    document.getElementById('btnAddItemRow').addEventListener('click', () => {
      const members = getTripScopedData().Members;
      draftItems.push({ id: Store.genId('itm'), originalName: '', zhName: '', quantity: 1, unitPriceOriginal: 0, subtotalOriginal: 0, isTaxRefundEligible: false, splitMode: 'equal', allocations: members.map(m => ({ memberId: m.id, splitType: 'equal', allocatedQty: 1, allocatedOriginal: 0 })) });
      renderDraftItems(members);
    });

    document.getElementById('btnResetExpenseForm').addEventListener('click', openNewExpense);
    document.getElementById('btnRunReceiptOcr').addEventListener('click', runReceiptOcr);
    document.getElementById('btnRunTaxOcr').addEventListener('click', runTaxOcr);

    document.getElementById('expenseForm').addEventListener('submit', e => {
      e.preventDefault();
      const tripId = Store.getActiveTripId(), data = getTripScopedData(), existingId = document.getElementById('expId').value, expenseId = existingId || Store.genId('exp');
      const expenseRecord = {
        id: expenseId, tripId, dateTime: document.getElementById('expDateTime').value, merchantName: document.getElementById('expMerchant').value.trim(),
        payerMemberId: document.getElementById('expPayer').value, paymentMethod: document.getElementById('expMethod').value,
        cardNote: document.getElementById('expCardNote').value.trim(), transitCardName: document.getElementById('expTransitName').value.trim(),
        currency: document.getElementById('expCurrency').value, originalAmount: Number(document.getElementById('expOriginalAmount').value || 0),
        exchangeRate: Number(document.getElementById('expExchangeRate').value || 1), twdAmount: Number(document.getElementById('expTwdAmount').value || 0),
        discountOriginal: Number(document.getElementById('expDiscount').value || 0), taxOriginal: Number(document.getElementById('expTaxFee').value || 0),
        feeOriginal: 0, receiptImageData: currentReceiptBase64 ? '[IMAGE_ATTACHED]' : '', note: document.getElementById('expNote').value.trim()
      };
      if (draftItems.length === 0) {
        draftItems = [{ id: Store.genId('itm'), originalName: expenseRecord.merchantName, zhName: expenseRecord.merchantName, quantity: 1, unitPriceOriginal: expenseRecord.originalAmount, subtotalOriginal: expenseRecord.originalAmount, isTaxRefundEligible: false, splitMode: 'equal', allocations: data.Members.map(m => ({ memberId: m.id, splitType: 'equal', allocatedQty: 1, allocatedOriginal: 0 })) }];
      }
      const itemRecords = draftItems.map(it => ({ id: it.id || Store.genId('itm'), expenseId, tripId, originalName: it.originalName || it.zhName, zhName: it.zhName || it.originalName, quantity: Number(it.quantity || 1), unitPriceOriginal: Number(it.unitPriceOriginal || 0), subtotalOriginal: Number(it.subtotalOriginal || 0), allocatedTwd: 0, isTaxRefundEligible: Boolean(it.isTaxRefundEligible), uncertain: Boolean(it.uncertain) }));
      const allocRecords = [];
      draftItems.forEach((it, idx) => (it.allocations || []).forEach(a => allocRecords.push({ id: a.id || Store.genId('alc'), expenseId, expenseItemId: itemRecords[idx].id, tripId, memberId: a.memberId, splitType: it.splitMode || a.splitType || 'equal', allocatedQty: Number(a.allocatedQty || 0), allocatedOriginal: Number(a.allocatedOriginal || 0), allocatedTwd: 0 })));
      const previewCheck = Engine.calculateExpenseBreakdown(expenseRecord, itemRecords, allocRecords);
      if (previewCheck.warnings.length > 0 && !confirm(`分帳提醒：
- ${previewCheck.warnings.join('
- ')}

確定仍要儲存嗎？`)) return;

      Store.mutate([
        ...data.ExpenseItems.filter(i => i.expenseId === expenseId).map(i => ({ table: 'ExpenseItems', type: 'delete', id: i.id })),
        ...data.Allocations.filter(a => a.expenseId === expenseId).map(a => ({ table: 'Allocations', type: 'delete', id: a.id })),
        { table: 'Expenses', type: 'upsert', record: expenseRecord },
        ...itemRecords.map(r => ({ table: 'ExpenseItems', type: 'upsert', record: r })),
        ...allocRecords.map(r => ({ table: 'Allocations', type: 'upsert', record: r }))
      ]);
      switchTab('expenses');
    });

    ['payOriginalAmount', 'payExchangeRate'].forEach(id => document.getElementById(id).addEventListener('input', () => {
      document.getElementById('payTwdAmount').value = Engine.roundAmount(Number(document.getElementById('payOriginalAmount').value || 0) * Number(document.getElementById('payExchangeRate').value || 1), 0);
    }));
    document.getElementById('paymentForm').addEventListener('submit', e => {
      e.preventDefault();
      const fromId = document.getElementById('payFromMember').value, toId = document.getElementById('payToMember').value;
      if (fromId === toId) { alert('付款者與收款者不能為同一人'); return; }
      Store.mutate([{ table: 'Payments', type: 'upsert', record: { id: Store.genId('pay'), tripId: Store.getActiveTripId(), dateTime: document.getElementById('payDateTime').value, fromMemberId: fromId, toMemberId: toId, currency: document.getElementById('payCurrency').value, originalAmount: Number(document.getElementById('payOriginalAmount').value || 0), exchangeRate: Number(document.getElementById('payExchangeRate').value || 1), twdAmount: Number(document.getElementById('payTwdAmount').value || 0), paymentMethod: document.getElementById('payMethod').value, relatedExpenseId: document.getElementById('payRelatedExpense').value, note: document.getElementById('payNote').value.trim() } }]);
      e.target.reset(); document.getElementById('payDateTime').value = nowLocalInput();
    });

    ['taxRefundOriginal', 'taxExchangeRate'].forEach(id => document.getElementById(id).addEventListener('input', () => {
      document.getElementById('taxRefundTwd').value = Engine.roundAmount(Number(document.getElementById('taxRefundOriginal').value || 0) * Number(document.getElementById('taxExchangeRate').value || 1), 0);
    }));
    document.getElementById('taxForm').addEventListener('submit', e => {
      e.preventDefault();
      const tripId = Store.getActiveTripId(), data = getTripScopedData(), taxId = Store.genId('tax');
      const checkedExpBoxes = Array.from(document.querySelectorAll('.tax-exp-check:checked'));
      if (checkedExpBoxes.length === 0) { alert('請至少勾選一張關聯消費收據'); return; }
      const taxRecord = { id: taxId, tripId, dateTime: document.getElementById('taxDateTime').value, title: document.getElementById('taxTitle').value.trim(), refundType: document.getElementById('taxRefundType').value, status: document.getElementById('taxStatus').value, currency: document.getElementById('taxCurrency').value, totalRefundOriginal: Number(document.getElementById('taxRefundOriginal').value || 0), exchangeRate: Number(document.getElementById('taxExchangeRate').value || 1), totalRefundTwd: Number(document.getElementById('taxRefundTwd').value || 0), receiverMemberId: document.getElementById('taxReceiverMember').value, allocationMode: 'proportional_auto', receiptImageData: '', note: document.getElementById('taxNote').value.trim() };
      const linkRecords = [], itemUpdateOps = [];
      checkedExpBoxes.forEach(cb => {
        const expId = cb.dataset.expId, exp = data.Expenses.find(x => x.id === expId);
        let eligibleOrigSum = 0;
        Array.from(document.querySelectorAll(`.tax-item-check[data-exp-id="${expId}"]`)).forEach(ic => {
          if (ic.checked) eligibleOrigSum += Number(ic.dataset.orig || 0);
          const existingItem = data.ExpenseItems.find(it => it.id === ic.dataset.itemId);
          if (existingItem && Boolean(existingItem.isTaxRefundEligible) !== ic.checked) itemUpdateOps.push({ table: 'ExpenseItems', type: 'upsert', record: { ...existingItem, isTaxRefundEligible: ic.checked } });
        });
        const manualOrig = Number(document.querySelector(`.tax-exp-manual-orig[data-exp-id="${expId}"]`)?.value || 0);
        linkRecords.push({ id: Store.genId('tl'), taxId, expenseId: expId, tripId, merchantName: exp ? exp.merchantName : '', eligibleSubtotalOriginal: Engine.roundAmount(eligibleOrigSum, 2), allocatedRefundOriginal: manualOrig > 0 ? manualOrig : 0, allocatedRefundTwd: 0, isEstimated: !(manualOrig > 0) });
      });
      Store.mutate([{ table: 'Taxes', type: 'upsert', record: taxRecord }, ...linkRecords.map(r => ({ table: 'TaxExpenseLinks', type: 'upsert', record: r })), ...itemUpdateOps]);
      e.target.reset(); document.getElementById('taxDateTime').value = nowLocalInput();
    });

    document.getElementById('tripForm').addEventListener('submit', e => {
      e.preventDefault(); const id = Store.genId('trip');
      Store.mutate([{ table: 'Trips', type: 'upsert', record: { id, name: document.getElementById('newTripName').value.trim(), baseCurrency: 'TWD', startDate: document.getElementById('newTripStart').value, endDate: document.getElementById('newTripEnd').value, status: 'active' } }]);
      Store.setActiveTripId(id); e.target.reset();
    });
    document.getElementById('memberForm').addEventListener('submit', e => {
      e.preventDefault();
      Store.mutate([{ table: 'Members', type: 'upsert', record: { id: Store.genId('mem'), tripId: Store.getActiveTripId(), name: document.getElementById('newMemberName').value.trim(), avatarColor: '#C86D3B', note: document.getElementById('newMemberNote').value.trim(), isActive: true } }]);
      e.target.reset();
    });

    document.getElementById('btnExportExcel').addEventListener('click', () => { const d = getTripScopedData(); Exporter.exportExcelWorkbook(d, Engine.calculateTripSettlement(d)); });
    document.getElementById('btnExportCsv').addEventListener('click', () => { const d = getTripScopedData(); Exporter.exportAllCSV(d, Engine.calculateTripSettlement(d)); });
    document.getElementById('btnExportJson').addEventListener('click', () => { const blob = new Blob([Store.exportJsonBackup()], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `TravelWallet_Backup_${new Date().toISOString().slice(0, 10)}.json`; a.click(); URL.revokeObjectURL(url); });
    document.getElementById('importJsonInput').addEventListener('change', async e => { const f = e.target.files?.[0]; if (!f) return; try { await Store.importJsonBackup(await f.text()); alert('還原成功！'); } catch (err) { alert('還原失敗：' + err.message); } });
    document.getElementById('btnLoadSeedData').addEventListener('click', () => { if (confirm('確定載入 5 大帳務測試案例示範資料？')) Store.loadSeedTestData(); });

    document.getElementById('credentialsForm').addEventListener('submit', async e => {
      e.preventDefault();
      Store.updateUserCredentials({
        gasUrl: document.getElementById('credGasUrl').value.trim(),
        gasSecret: document.getElementById('credGasSecret').value.trim(),
        userGeminiKey: document.getElementById('credGeminiKey').value.trim(),
        userOpenAIKey: document.getElementById('credOpenAIKey').value.trim()
      });
      await Store.pullFromCloud();
      alert('本機憑證已儲存！若已填入 GAS 網址，已同步載入最新雲端資料。');
    });

    document.getElementById('btnClearCredentials').addEventListener('click', () => {
      Store.updateUserCredentials({ gasUrl: '', gasSecret: '', userGeminiKey: '', userOpenAIKey: '' });
      alert('已清除本機儲存的金鑰與試算表網址。');
    });
  }

  async function boot() {
    Store.loadLocalCache();
    if (Store.getState().Trips.length === 0) Store.loadSeedTestData();
    Store.subscribe(renderAll);
    initEvents();
    document.getElementById('expDateTime').value = nowLocalInput();
    document.getElementById('payDateTime').value = nowLocalInput();
    document.getElementById('taxDateTime').value = nowLocalInput();
    openNewExpense();
    switchTab('overview');
    await Store.pullFromCloud();
  }

  document.addEventListener('DOMContentLoaded', boot);
  return { openNewExpense, editExpense, deleteExpense, updateDraftItem, removeDraftItem, changeItemSplitMode, toggleItemMemberEqual, setItemMemberValue, deletePayment, deleteTax, confirmSettlementTransfer, showMemberTrace, deleteMember };
})();
