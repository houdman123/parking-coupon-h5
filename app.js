(function () {
  'use strict';

  var STORAGE_KEY = 'parking_coupon_h5_v3';
  var VERSION = 'v2026.04.20-3';
  var EXECUTE_COOLDOWN_MS = 5000;
  var DUPLICATE_WARN_MS = 2 * 60 * 1000;

  var state = loadState();
  var editingAccountId = null;
  var currentPlan = null;
  var lastExecuteAt = 0;

  var refs = {};

  document.addEventListener('DOMContentLoaded', function () {
    bindRefs();
    bindEvents();
    renderAll();
  });

  function bindRefs() {
    refs.tabButtons = document.querySelectorAll('.tab-btn');
    refs.panels = {
      home: document.getElementById('tab-home'),
      accounts: document.getElementById('tab-accounts'),
      records: document.getElementById('tab-records'),
      summary: document.getElementById('tab-summary')
    };
    refs.activeAccountCount = document.getElementById('activeAccountCount');
    refs.totalCoupons = document.getElementById('totalCoupons');
    refs.monthDeductAmount = document.getElementById('monthDeductAmount');
    refs.quickAmountGrid = document.getElementById('quickAmountGrid');
    refs.customAmount = document.getElementById('customAmount');
    refs.selectedAmountText = document.getElementById('selectedAmountText');
    refs.btnPreview = document.getElementById('btnPreview');
    refs.btnExecute = document.getElementById('btnExecute');
    refs.planEmpty = document.getElementById('planEmpty');
    refs.planContent = document.getElementById('planContent');
    refs.accountName = document.getElementById('accountName');
    refs.accountCoupons = document.getElementById('accountCoupons');
    refs.accountStatus = document.getElementById('accountStatus');
    refs.btnResetForm = document.getElementById('btnResetForm');
    refs.btnSaveAccount = document.getElementById('btnSaveAccount');
    refs.accountList = document.getElementById('accountList');
    refs.recordList = document.getElementById('recordList');
    refs.summaryBox = document.getElementById('summaryBox');
    refs.btnResetMonth = document.getElementById('btnResetMonth');
    refs.btnExportData = document.getElementById('btnExportData');
  }

  function bindEvents() {
    each(refs.tabButtons, function (btn) {
      btn.addEventListener('click', function () {
        switchTab(btn.getAttribute('data-tab'));
      });
    });

    each(refs.quickAmountGrid.querySelectorAll('.quick-btn'), function (btn) {
      btn.addEventListener('click', function () {
        var amount = parseInt(btn.getAttribute('data-amount'), 10);
        setSelectedAmount(amount, true);
      });
    });

    refs.customAmount.addEventListener('input', function () {
      clearQuickSelection();
      var value = parseInt(refs.customAmount.value, 10);
      if (!isNaN(value)) {
        state.selectedAmount = value;
      } else {
        state.selectedAmount = null;
      }
      currentPlan = null;
      saveState();
      renderHome();
    });

    refs.btnPreview.addEventListener('click', function () {
      previewPlan();
    });

    refs.btnExecute.addEventListener('click', function () {
      executePlanWithConfirm();
    });

    refs.btnResetForm.addEventListener('click', function () {
      resetAccountForm();
    });

    refs.btnSaveAccount.addEventListener('click', function () {
      saveAccount();
    });

    refs.btnResetMonth.addEventListener('click', function () {
      resetMonth();
    });

    refs.btnExportData.addEventListener('click', function () {
      exportData();
    });
  }

  function switchTab(tabName) {
    each(refs.tabButtons, function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-tab') === tabName);
    });
    for (var key in refs.panels) {
      if (Object.prototype.hasOwnProperty.call(refs.panels, key)) {
        refs.panels[key].classList.toggle('active', key === tabName);
      }
    }
  }

  function setSelectedAmount(amount, clearCustom) {
    state.selectedAmount = amount;
    currentPlan = null;
    if (clearCustom) {
      refs.customAmount.value = '';
    }
    each(refs.quickAmountGrid.querySelectorAll('.quick-btn'), function (btn) {
      btn.classList.toggle('active', parseInt(btn.getAttribute('data-amount'), 10) === amount);
    });
    saveState();
    renderHome();
  }

  function clearQuickSelection() {
    each(refs.quickAmountGrid.querySelectorAll('.quick-btn'), function (btn) {
      btn.classList.remove('active');
    });
  }

  function getActiveAccounts() {
    var arr = [];
    each(state.accounts, function (item) {
      if (item.status === 'normal') arr.push(item);
    });
    return arr;
  }

  function getTotalCoupons() {
    var total = 0;
    each(getActiveAccounts(), function (item) {
      total += toInt(item.remaining, 0);
    });
    return total;
  }

  function getMonthDeductAmount() {
    var total = 0;
    each(state.records, function (item) {
      if (item.status === 'success' || item.status === 'partial') {
        total += toInt(item.successAmount, 0);
      }
    });
    return total;
  }

  function previewPlan() {
    var amount = getSelectedAmount();
    if (!validateAmount(amount, true)) return null;
    var plan = buildPlan(amount);
    currentPlan = plan;
    renderPlan(plan);
    return plan;
  }

  function executePlanWithConfirm() {
    var now = Date.now();
    if (now - lastExecuteAt < EXECUTE_COOLDOWN_MS) {
      alert('请不要连续点击，稍等几秒再试。');
      return;
    }

    var plan = currentPlan || previewPlan();
    if (!plan) return;

    if (!plan.ok) {
      alert(plan.message || '当前方案不可执行。');
      return;
    }

    var duplicate = findRecentDuplicate(plan.amount);
    if (duplicate) {
      var duplicateText = '你在 2 分钟内已经成功执行过一笔 ' + plan.amount + ' 元扣费，\n时间：' + formatTime(duplicate.createdAt) + '\n是否仍要继续？';
      if (!window.confirm(duplicateText)) {
        return;
      }
    }

    var confirmText = buildConfirmText(plan);
    if (!window.confirm(confirmText)) {
      return;
    }

    lastExecuteAt = now;
    doExecute(plan);
  }

  function doExecute(plan) {
    var snapshot = deepClone(state.accounts);
    var successRounds = [];
    var failedRounds = [];
    var successAmount = 0;
    var successCoupons = 0;

    each(plan.rounds, function (round) {
      if (round.ok) {
        applyRound(round);
        successRounds.push(round);
        successAmount += round.amount;
        successCoupons += round.requiredCoupons;
      } else {
        failedRounds.push(round);
      }
    });

    var record = {
      id: createId('rec'),
      createdAt: Date.now(),
      amount: plan.amount,
      requiredCoupons: plan.requiredCoupons,
      roundCount: plan.rounds.length,
      rounds: plan.rounds,
      successAmount: successAmount,
      successCoupons: successCoupons,
      status: failedRounds.length === 0 ? 'success' : (successRounds.length > 0 ? 'partial' : 'failed'),
      planText: buildPlanText(plan)
    };

    state.records.unshift(record);
    saveState();
    currentPlan = null;
    renderAll();

    if (record.status === 'success') {
      alert('执行成功。\n本次金额：' + record.amount + ' 元\n成功抵扣：' + record.successAmount + ' 元');
    } else if (record.status === 'partial') {
      alert('部分成功。\n本次金额：' + record.amount + ' 元\n成功抵扣：' + record.successAmount + ' 元\n其余部分未完成。');
    } else {
      state.accounts = snapshot;
      saveState();
      renderAll();
      alert('执行失败，本次未扣费。');
    }
  }

  function applyRound(round) {
    each(round.allocations, function (alloc) {
      var acc = findAccountById(alloc.accountId);
      if (acc) {
        acc.remaining = toInt(acc.remaining, 0) - alloc.coupons;
        if (acc.remaining < 0) acc.remaining = 0;
        acc.used = toInt(acc.used, 0) + alloc.coupons;
        acc.lastSuccessAt = Date.now();
      }
    });
  }

  function buildPlan(amount) {
    var plan = {
      ok: true,
      amount: amount,
      requiredCoupons: amount / 5,
      rounds: [],
      message: ''
    };

    var activeAccounts = sortAccountsForAllocation(getActiveAccounts());
    var totalCoupons = getTotalCoupons();
    if (totalCoupons < plan.requiredCoupons) {
      plan.ok = false;
      plan.message = '当前总剩余券不足，还差 ' + (plan.requiredCoupons - totalCoupons) + ' 张。';
      return plan;
    }

    var remainAmount = amount;
    var shadow = deepClone(activeAccounts);
    var roundNo = 0;

    while (remainAmount > 0) {
      roundNo += 1;
      var roundAmount = remainAmount >= 25 ? 25 : remainAmount;
      var roundCoupons = roundAmount / 5;
      var alloc = allocateCoupons(shadow, roundCoupons);
      var round = {
        roundNo: roundNo,
        amount: roundAmount,
        requiredCoupons: roundCoupons,
        allocations: alloc.allocations,
        ok: alloc.ok,
        message: alloc.message || ''
      };
      plan.rounds.push(round);
      if (!alloc.ok) {
        plan.ok = false;
      }
      remainAmount -= roundAmount;
    }

    return plan;
  }

  function allocateCoupons(accounts, needCoupons) {
    var remainingNeed = needCoupons;
    var allocations = [];
    var sorted = sortAccountsForAllocation(accounts);

    for (var i = 0; i < sorted.length; i += 1) {
      if (remainingNeed <= 0) break;
      var acc = sorted[i];
      var available = toInt(acc.remaining, 0);
      if (available <= 0) continue;
      var useCoupons = available >= remainingNeed ? remainingNeed : available;
      acc.remaining = available - useCoupons;
      allocations.push({
        accountId: acc.id,
        name: acc.name,
        coupons: useCoupons,
        amount: useCoupons * 5
      });
      remainingNeed -= useCoupons;
    }

    return {
      ok: remainingNeed === 0,
      message: remainingNeed === 0 ? '' : '券数不足',
      allocations: allocations
    };
  }

  function sortAccountsForAllocation(accounts) {
    var arr = deepClone(accounts);
    arr.sort(function (a, b) {
      var diff = toInt(b.remaining, 0) - toInt(a.remaining, 0);
      if (diff !== 0) return diff;
      return (a.name || '').localeCompare(b.name || '');
    });
    return arr;
  }

  function renderAll() {
    renderHome();
    renderAccounts();
    renderRecords();
    renderSummary();
  }

  function renderHome() {
    refs.activeAccountCount.textContent = String(getActiveAccounts().length);
    refs.totalCoupons.textContent = String(getTotalCoupons());
    refs.monthDeductAmount.textContent = getMonthDeductAmount() + '元';
    var amount = getSelectedAmount();
    refs.selectedAmountText.textContent = amount ? ('当前金额：' + amount + ' 元') : '当前未选择金额';
    if (!currentPlan) {
      refs.planEmpty.classList.remove('hidden');
      refs.planContent.classList.add('hidden');
      refs.planContent.innerHTML = '';
    }
  }

  function renderPlan(plan) {
    refs.planEmpty.classList.add('hidden');
    refs.planContent.classList.remove('hidden');
    if (!plan.ok && (!plan.rounds || plan.rounds.length === 0)) {
      refs.planContent.innerHTML = '<div class="plan-box"><div class="plan-line">' + escapeHtml(plan.message) + '</div></div>';
      return;
    }

    var html = '';
    html += '<div class="plan-box">';
    html += '<div class="plan-line"><strong>总金额：</strong>' + plan.amount + ' 元</div>';
    html += '<div class="plan-line"><strong>总券数：</strong>' + plan.requiredCoupons + ' 张</div>';
    html += '<div class="plan-line"><strong>执行轮数：</strong>' + plan.rounds.length + ' 轮</div>';

    each(plan.rounds, function (round) {
      html += '<div class="plan-detail">';
      html += '<div class="plan-line"><strong>第 ' + round.roundNo + ' 轮：</strong>' + round.amount + ' 元，需 ' + round.requiredCoupons + ' 张</div>';
      if (round.allocations.length === 0) {
        html += '<div class="plan-line">无可用账号</div>';
      } else {
        each(round.allocations, function (alloc) {
          html += '<div class="plan-line">' + escapeHtml(alloc.name) + '：' + alloc.coupons + ' 张（' + alloc.amount + ' 元）</div>';
        });
      }
      if (!round.ok) {
        html += '<div class="plan-line" style="color:#e5484d;">本轮不可执行：' + escapeHtml(round.message || '券不足') + '</div>';
      }
      html += '</div>';
    });

    html += '</div>';
    refs.planContent.innerHTML = html;
  }

  function renderAccounts() {
    if (!state.accounts.length) {
      refs.accountList.innerHTML = '<div class="empty">还没有账号，先新增一个测试账号。</div>';
      return;
    }

    var html = '';
    each(state.accounts, function (acc) {
      html += '<div class="list-item">';
      html += '<div class="item-top"><div class="item-title">' + escapeHtml(acc.name) + '</div>';
      html += '<div class="badge ' + (acc.status === 'normal' ? 'ok' : 'gray') + '">' + (acc.status === 'normal' ? '正常' : '停用') + '</div></div>';
      html += '<div class="meta">剩余券数：' + toInt(acc.remaining, 0) + ' 张<br>本月已用：' + toInt(acc.used, 0) + ' 张' + (acc.lastSuccessAt ? '<br>最近成功：' + formatTime(acc.lastSuccessAt) : '') + '</div>';
      html += '<div class="inline-actions">';
      html += '<button class="small-btn" data-action="edit" data-id="' + acc.id + '">编辑</button>';
      html += '<button class="small-btn" data-action="toggle" data-id="' + acc.id + '">' + (acc.status === 'normal' ? '停用' : '启用') + '</button>';
      html += '<button class="small-btn danger" data-action="delete" data-id="' + acc.id + '">删除</button>';
      html += '</div></div>';
    });
    refs.accountList.innerHTML = html;

    each(refs.accountList.querySelectorAll('button[data-action]'), function (btn) {
      btn.addEventListener('click', function () {
        var action = btn.getAttribute('data-action');
        var id = btn.getAttribute('data-id');
        if (action === 'edit') editAccount(id);
        if (action === 'toggle') toggleAccount(id);
        if (action === 'delete') deleteAccount(id);
      });
    });
  }

  function renderRecords() {
    if (!state.records.length) {
      refs.recordList.innerHTML = '<div class="empty">还没有扣费记录。</div>';
      return;
    }
    var html = '';
    each(state.records, function (rec) {
      var badgeCls = rec.status === 'success' ? 'ok' : (rec.status === 'partial' ? '' : 'gray');
      var badgeText = rec.status === 'success' ? '成功' : (rec.status === 'partial' ? '部分成功' : '失败');
      html += '<div class="list-item">';
      html += '<div class="item-top"><div class="item-title">' + rec.amount + ' 元</div><div class="badge ' + badgeCls + '">' + badgeText + '</div></div>';
      html += '<div class="meta">时间：' + formatTime(rec.createdAt) + '<br>需券：' + rec.requiredCoupons + ' 张<br>成功抵扣：' + rec.successAmount + ' 元<br>轮次：' + rec.roundCount + '</div>';
      html += '<div class="meta">' + escapeHtml(rec.planText).replace(/\n/g, '<br>') + '</div>';
      html += '</div>';
    });
    refs.recordList.innerHTML = html;
  }

  function renderSummary() {
    var activeCount = getActiveAccounts().length;
    var totalCoupons = 0;
    var usedCoupons = 0;
    each(state.accounts, function (acc) {
      totalCoupons += toInt(acc.remaining, 0) + toInt(acc.used, 0);
      usedCoupons += toInt(acc.used, 0);
    });
    var remainCoupons = getTotalCoupons();
    var totalDeduct = getMonthDeductAmount();
    var html = '';
    html += '<div class="plan-box">';
    html += '<div class="plan-line"><strong>版本：</strong>' + VERSION + '</div>';
    html += '<div class="plan-line"><strong>当前正常账号数：</strong>' + activeCount + '</div>';
    html += '<div class="plan-line"><strong>本月总券数：</strong>' + totalCoupons + ' 张</div>';
    html += '<div class="plan-line"><strong>本月已用券数：</strong>' + usedCoupons + ' 张</div>';
    html += '<div class="plan-line"><strong>本月剩余券数：</strong>' + remainCoupons + ' 张</div>';
    html += '<div class="plan-line"><strong>本月总抵扣金额：</strong>' + totalDeduct + ' 元</div>';
    html += '<div class="plan-line"><strong>本月扣费笔数：</strong>' + state.records.length + ' 笔</div>';
    html += '</div>';
    refs.summaryBox.innerHTML = html;
  }

  function saveAccount() {
    var name = trim(refs.accountName.value);
    var coupons = toInt(refs.accountCoupons.value, 30);
    var status = refs.accountStatus.value || 'normal';

    if (!name) {
      alert('请填写账号备注名。');
      return;
    }
    if (coupons < 0) {
      alert('剩余券数不能小于 0。');
      return;
    }

    if (editingAccountId) {
      var acc = findAccountById(editingAccountId);
      if (acc) {
        acc.name = name;
        acc.remaining = coupons;
        acc.status = status;
      }
    } else {
      state.accounts.push({
        id: createId('acc'),
        name: name,
        remaining: coupons,
        used: 0,
        status: status,
        createdAt: Date.now(),
        lastSuccessAt: null
      });
    }
    saveState();
    resetAccountForm();
    renderAll();
    switchTab('accounts');
  }

  function editAccount(id) {
    var acc = findAccountById(id);
    if (!acc) return;
    editingAccountId = id;
    refs.accountName.value = acc.name;
    refs.accountCoupons.value = acc.remaining;
    refs.accountStatus.value = acc.status;
    switchTab('accounts');
  }

  function toggleAccount(id) {
    var acc = findAccountById(id);
    if (!acc) return;
    acc.status = acc.status === 'normal' ? 'disabled' : 'normal';
    saveState();
    renderAll();
  }

  function deleteAccount(id) {
    if (!window.confirm('确认删除这个账号吗？')) return;
    state.accounts = state.accounts.filter(function (item) { return item.id !== id; });
    if (editingAccountId === id) editingAccountId = null;
    saveState();
    resetAccountForm();
    renderAll();
  }

  function resetAccountForm() {
    editingAccountId = null;
    refs.accountName.value = '';
    refs.accountCoupons.value = '';
    refs.accountStatus.value = 'normal';
  }

  function resetMonth() {
    if (!window.confirm('确认执行月度清零吗？这会把当前剩余券视为失效，并清空本月已用数和本月记录。')) return;
    each(state.accounts, function (acc) {
      acc.used = 0;
      acc.remaining = 30;
      acc.lastSuccessAt = null;
    });
    state.records = [];
    state.selectedAmount = null;
    currentPlan = null;
    saveState();
    renderAll();
    alert('月度数据已重置。');
  }

  function exportData() {
    var data = JSON.stringify(state, null, 2);
    var html = '<pre class="export-box">' + escapeHtml(data) + '</pre>';
    refs.summaryBox.insertAdjacentHTML('beforeend', html);
    setTimeout(function () {
      var box = refs.summaryBox.querySelector('.export-box');
      if (box) box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
  }

  function buildConfirmText(plan) {
    var text = '本次金额：' + plan.amount + ' 元\n';
    text += '需要券数：' + plan.requiredCoupons + ' 张\n';
    text += '执行轮数：' + plan.rounds.length + ' 轮\n';
    each(plan.rounds, function (round) {
      text += '\n第 ' + round.roundNo + ' 轮：' + round.amount + ' 元\n';
      each(round.allocations, function (alloc) {
        text += alloc.name + '：' + alloc.coupons + ' 张\n';
      });
    });
    text += '\n确认后才会执行。';
    return text;
  }

  function buildPlanText(plan) {
    var lines = [];
    lines.push('总金额：' + plan.amount + ' 元');
    lines.push('总券数：' + plan.requiredCoupons + ' 张');
    each(plan.rounds, function (round) {
      var arr = [];
      each(round.allocations, function (alloc) {
        arr.push(alloc.name + ' ' + alloc.coupons + '张');
      });
      lines.push('第' + round.roundNo + '轮：' + round.amount + '元；' + arr.join('，'));
    });
    return lines.join('\n');
  }

  function findRecentDuplicate(amount) {
    var now = Date.now();
    for (var i = 0; i < state.records.length; i += 1) {
      var rec = state.records[i];
      if (rec.status !== 'success' && rec.status !== 'partial') continue;
      if (rec.amount === amount && now - rec.createdAt <= DUPLICATE_WARN_MS) {
        return rec;
      }
    }
    return null;
  }

  function getSelectedAmount() {
    var amount = state.selectedAmount;
    return toInt(amount, 0);
  }

  function validateAmount(amount, needAlert) {
    if (!amount || amount <= 0) {
      if (needAlert) alert('请先选择或输入金额。');
      return false;
    }
    if (amount % 5 !== 0) {
      if (needAlert) alert('金额必须是 5 元的整数倍。');
      return false;
    }
    return true;
  }

  function loadState() {
    var raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createDefaultState();
    try {
      var data = JSON.parse(raw);
      if (!data || typeof data !== 'object') return createDefaultState();
      if (!Array.isArray(data.accounts)) data.accounts = [];
      if (!Array.isArray(data.records)) data.records = [];
      if (typeof data.selectedAmount === 'undefined') data.selectedAmount = null;
      return data;
    } catch (e) {
      return createDefaultState();
    }
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function createDefaultState() {
    return {
      accounts: [
        { id: createId('acc'), name: '测试账号A', remaining: 30, used: 0, status: 'normal', createdAt: Date.now(), lastSuccessAt: null },
        { id: createId('acc'), name: '测试账号B', remaining: 20, used: 0, status: 'normal', createdAt: Date.now(), lastSuccessAt: null }
      ],
      records: [],
      selectedAmount: null
    };
  }

  function findAccountById(id) {
    for (var i = 0; i < state.accounts.length; i += 1) {
      if (state.accounts[i].id === id) return state.accounts[i];
    }
    return null;
  }

  function formatTime(ts) {
    var d = new Date(ts);
    var y = d.getFullYear();
    var m = pad(d.getMonth() + 1);
    var day = pad(d.getDate());
    var h = pad(d.getHours());
    var min = pad(d.getMinutes());
    return y + '-' + m + '-' + day + ' ' + h + ':' + min;
  }

  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function toInt(val, fallback) {
    var n = parseInt(val, 10);
    return isNaN(n) ? fallback : n;
  }
  function trim(str) { return (str || '').replace(/^\s+|\s+$/g, ''); }
  function createId(prefix) { return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8); }
  function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }
  function each(list, fn) { Array.prototype.forEach.call(list || [], fn); }
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
})();
