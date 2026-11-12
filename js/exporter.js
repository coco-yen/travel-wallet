window.TravelExporter = (function () {
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function exportAllCSV(tripState, settlement) {
    const lines = [];
    const addSection = (title, headers, rows) => {
      lines.push(`=== ${title} ===`);
      lines.push(headers.map(h => `"${String(h).replace(/"/g, '""')}"`).join(','));
      rows.forEach(r => lines.push(r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')));
      lines.push('');
    };
    const memberMap = Object.fromEntries((tripState.Members || []).map(m => [m.id, m.name]));
    addSection(
      '消費紀錄',
      ['ID', '日期時間', '店家名稱', '付款人', '付款方式', '幣別', '原幣金額', '匯率', '台幣金額', '備註'],
      (tripState.Expenses || []).map(e => [
        e.id, e.dateTime, e.merchantName, memberMap[e.payerMemberId] || e.payerMemberId,
        e.paymentMethod, e.currency, e.originalAmount, e.exchangeRate, e.twdAmount, e.note
      ])
    );
    addSection(
      '最終結算',
      ['旅伴', '消費代墊(TWD)', '已轉出(TWD)', '已收到(TWD)', '代收退稅(TWD)', '消費總分攤(TWD)', '退稅折抵(TWD)', '淨應負擔(TWD)', '最終餘額(TWD)'],
      (settlement.summaries || []).map(s => [
        s.name, s.paidForExpensesTwd, s.transfersSentTwd, s.transfersReceivedTwd,
        s.taxRefundReceivedTwd, s.grossShareTwd, s.taxRefundBenefitTwd, s.netShareTwd, s.netBalanceTwd
      ])
    );
    const csvText = '\uFEFF' + lines.join('\n');
    downloadBlob(new Blob([csvText], { type: 'text/csv;charset=utf-8;' }), `TravelWallet_${new Date().toISOString().slice(0, 10)}.csv`);
  }

  function exportExcelWorkbook(tripState, settlement) {
    if (typeof XLSX === 'undefined') {
      alert('Excel 套件載入中，請稍候或使用 CSV 匯出');
      return;
    }
    const wb = XLSX.utils.book_new();
    const memberMap = Object.fromEntries((tripState.Members || []).map(m => [m.id, m.name]));
    const addSheet = (name, rows) => XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows.length ? rows : [{ 提示: '無資料' }]), name.slice(0, 31));
    addSheet('1_成員', (tripState.Members || []).map(m => ({ 成員ID: m.id, 姓名: m.name, 備註: m.note })));
    addSheet('2_消費紀錄', (tripState.Expenses || []).map(e => ({ 消費ID: e.id, 日期時間: e.dateTime, 店家: e.merchantName, 付款人: memberMap[e.payerMemberId] || e.payerMemberId, 方式: e.paymentMethod, 幣別: e.currency, 原幣: e.originalAmount, 台幣: e.twdAmount })));
    addSheet('3_品項明細', (tripState.ExpenseItems || []).map(i => ({ 品項ID: i.id, 消費ID: i.expenseId, 原文: i.originalName, 中文: i.zhName, 數量: i.quantity, 原幣小計: i.subtotalOriginal, 可退稅: i.isTaxRefundEligible ? '是' : '否' })));
    addSheet('4_品項分帳', (tripState.Allocations || []).map(a => ({ 分帳ID: a.id, 品項ID: a.expenseItemId, 旅伴: memberMap[a.memberId] || a.memberId, 方式: a.splitType, 數量: a.allocatedQty, 原幣: a.allocatedOriginal, 台幣: a.allocatedTwd })));
    addSheet('5_收付款', (tripState.Payments || []).map(p => ({ ID: p.id, 日期: p.dateTime, 付款者: memberMap[p.fromMemberId], 收款者: memberMap[p.toMemberId], 幣別: p.currency, 原幣: p.originalAmount, 台幣: p.twdAmount })));
    addSheet('6_退稅紀錄', (tripState.Taxes || []).map(t => ({ ID: t.id, 名稱: t.title, 狀態: t.status, 幣別: t.currency, 退稅原幣: t.totalRefundOriginal, 退稅台幣: t.totalRefundTwd, 收款人: memberMap[t.receiverMemberId] })));
    addSheet('7_最終結算', (settlement.summaries || []).map(s => ({ 旅伴: s.name, 消費代墊: s.paidForExpensesTwd, 淨應負擔: s.netShareTwd, 最終餘額: s.netBalanceTwd })));
    XLSX.writeFile(wb, `TravelWallet_帳務報表_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  return { exportAllCSV, exportExcelWorkbook };
})();
