(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TravelEngine = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  function roundAmount(val, decimals = 0) {
    const factor = Math.pow(10, decimals);
    return Math.round((Number(val || 0) + Number.EPSILON) * factor) / factor;
  }

  function allocateProportionally(targetTotal, weights, decimals = 0) {
    const n = weights.length;
    if (n === 0) return [];
    const factor = Math.pow(10, decimals);
    const targetUnits = Math.round(Number(targetTotal || 0) * factor);
    const totalWeight = weights.reduce((acc, w) => acc + Math.max(0, Number(w || 0)), 0);
    if (totalWeight <= 0) {
      const base = Math.floor(targetUnits / n);
      let rem = targetUnits - base * n;
      return weights.map((_, i) => (base + (i < rem ? 1 : 0)) / factor);
    }
    const exacts = weights.map(w => (targetUnits * Math.max(0, Number(w || 0))) / totalWeight);
    const floors = exacts.map(x => Math.floor(x));
    let remainder = targetUnits - floors.reduce((a, b) => a + b, 0);
    const indices = exacts.map((val, idx) => ({ idx, frac: val - floors[idx] })).sort((a, b) => b.frac - a.frac);
    for (let i = 0; i < remainder; i++) floors[indices[i % n].idx] += 1;
    return floors.map(u => u / factor);
  }

  function calculateExpenseBreakdown(expense, items, allocations) {
    const validItems = items.filter(it => it.expenseId === expense.id);
    const itemsOriginalSum = validItems.reduce((s, it) => s + Number(it.subtotalOriginal || 0), 0);
    const discount = Number(expense.discountOriginal || 0);
    const tax = Number(expense.taxOriginal || 0);
    const fee = Number(expense.feeOriginal || 0);
    const netOriginal = validItems.length > 0 ? roundAmount(itemsOriginalSum - discount + tax + fee, 2) : Number(expense.originalAmount || 0);
    const rate = Number(expense.exchangeRate || 1);
    const finalTwd = Number(expense.twdAmount) > 0 ? roundAmount(expense.twdAmount, 0) : roundAmount(netOriginal * rate, 0);

    const itemWeights = validItems.map(it => Number(it.subtotalOriginal || 0));
    const itemTwdList = allocateProportionally(finalTwd, itemWeights, 0);
    const itemResults = [];
    const memberTwdTotals = {};
    const warnings = [];

    validItems.forEach((item, idx) => {
      const itemTwd = itemTwdList[idx];
      const itemAllocs = allocations.filter(a => a.expenseItemId === item.id);
      const itemQty = Number(item.quantity || 1);
      const itemOrig = Number(item.subtotalOriginal || 0);

      if (itemAllocs.length === 0) {
        warnings.push(`品項「${item.zhName || item.originalName}」尚未指定負擔旅伴（原幣 ${itemOrig}）`);
        itemResults.push({ ...item, computedTwd: itemTwd, memberSplits: [], unallocatedOriginal: itemOrig, unallocatedTwd: itemTwd });
        return;
      }

      let weights = [], allocatedOrigSum = 0, allocatedQtySum = 0;
      itemAllocs.forEach(a => {
        if (a.splitType === 'quantity') {
          const q = Number(a.allocatedQty || 0);
          allocatedQtySum += q;
          weights.push(q);
          allocatedOrigSum += itemQty > 0 ? (itemOrig * q) / itemQty : 0;
        } else if (a.splitType === 'amount') {
          const amt = Number(a.allocatedOriginal || 0);
          allocatedOrigSum += amt;
          weights.push(amt);
        } else {
          weights.push(1);
          allocatedOrigSum += itemOrig / itemAllocs.length;
        }
      });

      if (itemAllocs.some(a => a.splitType === 'quantity')) {
        if (allocatedQtySum > itemQty + 1e-6) warnings.push(`品項「${item.zhName || item.originalName}」分配數量 (${allocatedQtySum}) 超過購買數量 (${itemQty})`);
        else if (allocatedQtySum < itemQty - 1e-6) warnings.push(`品項「${item.zhName || item.originalName}」尚有 ${roundAmount(itemQty - allocatedQtySum, 2)} 數量未分配`);
      } else if (itemAllocs.some(a => a.splitType === 'amount')) {
        if (Math.abs(allocatedOrigSum - itemOrig) > 0.05) warnings.push(`品項「${item.zhName || item.originalName}」自訂分配原幣 (${roundAmount(allocatedOrigSum, 2)}) 與品項小計 (${itemOrig}) 不符`);
      }

      const splitTwds = allocateProportionally(itemTwd, weights, 0);
      const splitOrigs = allocateProportionally(itemOrig, weights, 2);
      const memberSplits = itemAllocs.map((a, aIdx) => {
        const mTwd = splitTwds[aIdx];
        memberTwdTotals[a.memberId] = (memberTwdTotals[a.memberId] || 0) + mTwd;
        return { allocationId: a.id, memberId: a.memberId, splitType: a.splitType, allocatedQty: a.allocatedQty, allocatedOriginal: splitOrigs[aIdx], allocatedTwd: mTwd };
      });
      itemResults.push({ ...item, computedTwd: itemTwd, memberSplits });
    });

    return { expenseId: expense.id, netOriginal, finalTwd, items: itemResults, memberTwdTotals, warnings };
  }

  function calculateCompositeTaxRefund(taxRecord, taxLinks, taxItemAllocs, allExpenses, allItems, allAllocations, otherTaxItemAllocs = []) {
    const links = taxLinks.filter(l => l.taxId === taxRecord.id);
    const totalRefundOrig = Number(taxRecord.totalRefundOriginal || 0);
    const rate = Number(taxRecord.exchangeRate || 1);
    const totalRefundTwd = Number(taxRecord.totalRefundTwd) > 0 ? roundAmount(taxRecord.totalRefundTwd, 0) : roundAmount(totalRefundOrig * rate, 0);
    const warnings = [];
    const alreadyRefundedItemIds = new Set(otherTaxItemAllocs.filter(a => a.taxId !== taxRecord.id && Number(a.refundOriginal || 0) > 0).map(a => a.expenseItemId));

    const hasManualLinkAmounts = links.some(l => Number(l.allocatedRefundOriginal || 0) > 0 && !l.isEstimated);
    const linkWeights = links.map(l => Number(l.eligibleSubtotalOriginal || 0));
    const autoLinkOrigs = allocateProportionally(totalRefundOrig, linkWeights, 2);

    const resolvedLinks = links.map((link, idx) => ({
      ...link,
      resolvedRefundOriginal: hasManualLinkAmounts ? roundAmount(link.allocatedRefundOriginal, 2) : autoLinkOrigs[idx],
      isEstimated: !hasManualLinkAmounts
    }));

    const linkOrigSum = roundAmount(resolvedLinks.reduce((s, l) => s + l.resolvedRefundOriginal, 0), 2);
    if (links.length > 0 && Math.abs(linkOrigSum - totalRefundOrig) > 0.05) {
      warnings.push(`各收據退稅分配合計 (${linkOrigSum}) 與退稅單總額 (${totalRefundOrig}) 不一致`);
    }

    const resolvedLinkTwds = allocateProportionally(totalRefundTwd, resolvedLinks.map(l => l.resolvedRefundOriginal), 0);
    resolvedLinks.forEach((l, i) => { l.resolvedRefundTwd = resolvedLinkTwds[i]; });

    const memberRefundTwd = {};
    const generatedItemAllocs = [];

    resolvedLinks.forEach(link => {
      const exp = allExpenses.find(e => e.id === link.expenseId);
      if (!exp) return;
      const existingForLink = taxItemAllocs.filter(a => a.taxId === taxRecord.id && a.expenseId === link.expenseId);
      const eligibleItems = allItems.filter(it => it.expenseId === link.expenseId && (
        existingForLink.length > 0 ? existingForLink.some(a => a.expenseItemId === it.id) : Boolean(it.isTaxRefundEligible)
      ));

      if (eligibleItems.length === 0) {
        warnings.push(`收據「${exp.merchantName}」未選擇任何符合退稅資格的商品`);
        return;
      }

      eligibleItems.forEach(it => {
        if (alreadyRefundedItemIds.has(it.id)) warnings.push(`警示：商品「${it.zhName || it.originalName}」已在其他退稅單申請過退稅`);
      });

      const itemWeights = eligibleItems.map(it => Number(it.subtotalOriginal || 0));
      const itemRefundOrigs = allocateProportionally(link.resolvedRefundOriginal, itemWeights, 2);
      const itemRefundTwds = allocateProportionally(link.resolvedRefundTwd, itemWeights, 0);

      eligibleItems.forEach((it, itIdx) => {
        const itemAllocs = allAllocations.filter(a => a.expenseItemId === it.id);
        if (itemAllocs.length === 0) {
          const fb = exp.payerMemberId;
          memberRefundTwd[fb] = (memberRefundTwd[fb] || 0) + itemRefundTwds[itIdx];
          return;
        }
        const memberWeights = itemAllocs.map(a => a.splitType === 'quantity' ? Number(a.allocatedQty || 0) : a.splitType === 'amount' ? Number(a.allocatedOriginal || 0) : 1);
        const mOrigs = allocateProportionally(itemRefundOrigs[itIdx], memberWeights, 2);
        const mTwds = allocateProportionally(itemRefundTwds[itIdx], memberWeights, 0);
        itemAllocs.forEach((a, mIdx) => {
          memberRefundTwd[a.memberId] = (memberRefundTwd[a.memberId] || 0) + mTwds[mIdx];
          generatedItemAllocs.push({
            id: `tia_${taxRecord.id}_${it.id}_${a.memberId}`, taxId: taxRecord.id, taxExpenseLinkId: link.id,
            expenseId: exp.id, expenseItemId: it.id, memberId: a.memberId, tripId: taxRecord.tripId,
            refundOriginal: mOrigs[mIdx], refundTwd: mTwds[mIdx], isManualOverride: false
          });
        });
      });
    });

    return { taxId: taxRecord.id, status: taxRecord.status, totalRefundOriginal: totalRefundOrig, totalRefundTwd, receiverMemberId: taxRecord.receiverMemberId, resolvedLinks, generatedItemAllocs, memberRefundTwd, warnings };
  }

  function calculateTripSettlement(state) {
    const members = state.Members || [], expenses = state.Expenses || [], items = state.ExpenseItems || [],
      allocations = state.Allocations || [], payments = state.Payments || [], taxes = state.Taxes || [],
      taxLinks = state.TaxExpenseLinks || [], taxItemAllocs = state.TaxItemAllocations || [];

    const ledger = {};
    members.forEach(m => {
      ledger[m.id] = { memberId: m.id, name: m.name, paidForExpensesTwd: 0, transfersSentTwd: 0, transfersReceivedTwd: 0, taxRefundReceivedTwd: 0, grossShareTwd: 0, taxRefundBenefitTwd: 0, netShareTwd: 0, totalContributionTwd: 0, netBalanceTwd: 0, traces: [] };
    });

    const expenseBreakdowns = expenses.map(exp => {
      const bd = calculateExpenseBreakdown(exp, items, allocations);
      if (ledger[exp.payerMemberId]) {
        ledger[exp.payerMemberId].paidForExpensesTwd += bd.finalTwd;
        ledger[exp.payerMemberId].traces.push({ type: 'EXPENSE_PAID', id: exp.id, dateTime: exp.dateTime, label: `代墊消費：${exp.merchantName}`, amountTwd: +bd.finalTwd });
      }
      Object.entries(bd.memberTwdTotals).forEach(([mId, shareTwd]) => {
        if (ledger[mId]) {
          ledger[mId].grossShareTwd += shareTwd;
          ledger[mId].traces.push({ type: 'EXPENSE_SHARE', id: exp.id, dateTime: exp.dateTime, label: `消費分攤：${exp.merchantName}`, amountTwd: -shareTwd });
        }
      });
      return bd;
    });

    payments.forEach(pay => {
      const twd = Number(pay.twdAmount) > 0 ? roundAmount(pay.twdAmount, 0) : roundAmount(Number(pay.originalAmount || 0) * Number(pay.exchangeRate || 1), 0);
      if (ledger[pay.fromMemberId]) {
        ledger[pay.fromMemberId].transfersSentTwd += twd;
        ledger[pay.fromMemberId].traces.push({ type: 'PAYMENT_SENT', id: pay.id, dateTime: pay.dateTime, label: `支付款項給 ${ledger[pay.toMemberId]?.name || pay.toMemberId}${pay.note ? ' (' + pay.note + ')' : ''}`, amountTwd: +twd });
      }
      if (ledger[pay.toMemberId]) {
        ledger[pay.toMemberId].transfersReceivedTwd += twd;
        ledger[pay.toMemberId].traces.push({ type: 'PAYMENT_RECEIVED', id: pay.id, dateTime: pay.dateTime, label: `收到來自 ${ledger[pay.fromMemberId]?.name || pay.fromMemberId} 的款項${pay.note ? ' (' + pay.note + ')' : ''}`, amountTwd: -twd });
      }
    });

    const activeTaxStatuses = new Set(['confirmed', 'processing', 'refunded']);
    const taxBreakdowns = taxes.map(tax => {
      const tbd = calculateCompositeTaxRefund(tax, taxLinks, taxItemAllocs, expenses, items, allocations, taxItemAllocs);
      if (activeTaxStatuses.has(tax.status) && tax.refundType !== 'onsite_deducted') {
        if (ledger[tax.receiverMemberId]) {
          ledger[tax.receiverMemberId].taxRefundReceivedTwd += tbd.totalRefundTwd;
          ledger[tax.receiverMemberId].traces.push({ type: 'TAX_RECEIVED', id: tax.id, dateTime: tax.dateTime, label: `代收退稅款：${tax.title}`, amountTwd: -tbd.totalRefundTwd });
        }
        Object.entries(tbd.memberRefundTwd).forEach(([mId, refundShare]) => {
          if (ledger[mId]) {
            ledger[mId].taxRefundBenefitTwd += refundShare;
            ledger[mId].traces.push({ type: 'TAX_BENEFIT', id: tax.id, dateTime: tax.dateTime, label: `退稅折抵分攤：${tax.title}`, amountTwd: +refundShare });
          }
        });
      }
      return tbd;
    });

    const summaries = Object.values(ledger).map(m => {
      m.netShareTwd = roundAmount(m.grossShareTwd - m.taxRefundBenefitTwd, 0);
      m.totalContributionTwd = roundAmount(m.paidForExpensesTwd + m.transfersSentTwd - m.transfersReceivedTwd - m.taxRefundReceivedTwd, 0);
      m.netBalanceTwd = roundAmount(m.totalContributionTwd - m.netShareTwd, 0);
      return m;
    });

    const debtors = summaries.filter(m => m.netBalanceTwd < 0).map(m => ({ memberId: m.memberId, name: m.name, amount: Math.abs(m.netBalanceTwd) })).sort((a, b) => b.amount - a.amount);
    const creditors = summaries.filter(m => m.netBalanceTwd > 0).map(m => ({ memberId: m.memberId, name: m.name, amount: m.netBalanceTwd })).sort((a, b) => b.amount - a.amount);
    const suggestedTransfers = [];
    let dIdx = 0, cIdx = 0;
    while (dIdx < debtors.length && cIdx < creditors.length) {
      const d = debtors[dIdx], c = creditors[cIdx], amt = Math.min(d.amount, c.amount);
      if (amt > 0) suggestedTransfers.push({ fromMemberId: d.memberId, fromName: d.name, toMemberId: c.memberId, toName: c.name, twdAmount: roundAmount(amt, 0) });
      d.amount -= amt; c.amount -= amt;
      if (d.amount <= 0) dIdx++;
      if (c.amount <= 0) cIdx++;
    }

    return { summaries, suggestedTransfers, expenseBreakdowns, taxBreakdowns };
  }

  return { roundAmount, allocateProportionally, calculateExpenseBreakdown, calculateCompositeTaxRefund, calculateTripSettlement };
}));
