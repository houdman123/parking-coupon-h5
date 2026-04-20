const state = {
  config: null,
  accounts: [],
  tasks: [],
  stats: null,
  preview: null,
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || '请求失败');
  return data.data;
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 1800);
}

function openModal(sel) { $(sel).classList.remove('hidden'); }
function closeModal(sel) { $(sel).classList.add('hidden'); }

function money(v) { return `${v} 元`; }

function renderStats() {
  const s = state.stats;
  $('#stats').innerHTML = s ? [
    ['正常账号', s.active_account_count],
    ['总券数', s.total_coupon_count],
    ['剩余券', s.remain_coupon_count],
    ['已抵扣', `${s.total_deduct_amount}元`],
  ].map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('') : '';
}

function renderAccounts() {
  const list = $('#accountsList');
  if (!state.accounts.length) {
    list.innerHTML = '<div class="item">还没有账号，先新增一个。</div>';
    return;
  }
  list.innerHTML = state.accounts.map(a => `
    <div class="item">
      <div class="item-head">
        <div>
          <h4>${a.owner_name}</h4>
          <div class="meta">
            <span>${a.login_name}</span>
            <span>剩余 ${a.remain_coupon_count} 张</span>
            <span>本月总额 ${a.month_quota} 张</span>
          </div>
        </div>
        <span class="badge ${a.status}">${a.status === 'normal' ? '正常' : a.status === 'abnormal' ? '异常' : '停用'}</span>
      </div>
      <div class="meta">
        <span>最近成功：${a.last_success_time || '暂无'}</span>
        <span>${a.note || ''}</span>
      </div>
      <div class="inline-actions">
        <button onclick="editAccount(${a.id})">编辑</button>
        <button onclick="removeAccount(${a.id})">删除</button>
      </div>
    </div>
  `).join('');
}

function renderTasks() {
  const list = $('#tasksList');
  if (!state.tasks.length) {
    list.innerHTML = '<div class="item">还没有任务记录。</div>';
    return;
  }
  list.innerHTML = state.tasks.map(t => {
    const rounds = (t.rounds || []).map(r => {
      const detailText = (r.details || []).map(d => `${d.owner_name} ${d.used_coupon_count}张`).join('，') || '无';
      return `<div class="preview-row">第${r.round_no}轮：${r.round_amount}元 / ${r.required_coupon_count}张 / <span class="badge ${r.status}">${statusLabel(r.status)}</span><br>${detailText}${r.error_message ? `（${r.error_message}）` : ''}</div>`;
    }).join('');
    return `
      <div class="item">
        <div class="item-head">
          <div>
            <h4>${money(t.input_amount)}</h4>
            <div class="meta">
              <span>任务 #${t.id}</span>
              <span>需要 ${t.required_coupon_count} 张</span>
              <span>成功 ${t.success_coupon_count} 张</span>
              <span>${t.created_at}</span>
            </div>
          </div>
          <span class="badge ${t.status}">${statusLabel(t.status)}</span>
        </div>
        ${t.duplicate_warning ? '<div class="preview-row">⚠️ 该任务创建时触发了 2 分钟内重复金额提醒</div>' : ''}
        ${rounds}
        ${t.error_message ? `<div class="preview-row">错误：${t.error_message}</div>` : ''}
      </div>`;
  }).join('');
}

function statusLabel(status) {
  return {
    success: '成功',
    failed: '失败',
    running: '执行中',
    partial_success: '部分成功',
  }[status] || status;
}

function renderPreview() {
  const box = $('#previewBox');
  const p = state.preview;
  if (!p) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  box.classList.remove('hidden');
  box.innerHTML = `
    <div class="preview-row"><strong>本次金额：</strong>${money(p.amount)}</div>
    <div class="preview-row"><strong>需要券数：</strong>${p.required_coupon_count} 张</div>
    <div class="preview-row"><strong>拆分轮次：</strong>${p.round_amounts.join(' + ')} </div>
    <div class="preview-row"><strong>总剩余券：</strong>${p.total_remaining} 张</div>
    ${p.duplicate_warning ? '<div class="preview-row">⚠️ 2 分钟内有同金额成功任务，请确认不是重复扣费。</div>' : ''}
    ${p.insufficient ? '<div class="preview-row">❌ 当前总剩余券不足，不能执行。</div>' : ''}
    <div class="preview-row"><strong>预计账号分配：</strong></div>
    ${(p.account_summary || []).map(x => `<div class="preview-row">${x.owner_name}：${x.coupon_count}张 / ${x.deduct_amount}元</div>`).join('') || '<div class="preview-row">无可用账号</div>'}
    <div class="preview-row"><strong>轮次明细：</strong></div>
    ${(p.round_plans || []).map(r => `<div class="preview-row">第${r.round_no}轮 ${r.round_amount}元：${(r.allocations || []).map(a => `${a.owner_name} ${a.coupon_count}张`).join('，') || '无'}</div>`).join('')}
    <div class="preview-actions">
      <button class="cancel" id="cancelPreviewBtn">取消</button>
      <button class="confirm" id="confirmExecuteBtn" ${p.insufficient ? 'disabled' : ''}>确认并执行</button>
    </div>
  `;
  $('#cancelPreviewBtn').onclick = () => { state.preview = null; renderPreview(); };
  $('#confirmExecuteBtn').onclick = executeTask;
}

async function loadAll() {
  const [config, accounts, stats, tasks] = await Promise.all([
    api('/api/config'), api('/api/accounts'), api('/api/stats'), api('/api/tasks')
  ]);
  state.config = config;
  state.accounts = accounts;
  state.stats = stats;
  state.tasks = tasks;
  $('#targetUrlInput').value = config.target_url || '';
  $('#executionModeSelect').value = config.execution_mode || 'mock';
  $('#requireConfirmInput').checked = !!config.require_confirmation;
  renderStats();
  renderAccounts();
  renderTasks();
}

async function createPreview() {
  const amount = Number($('#amountInput').value || 0);
  if (!amount || amount % 5 !== 0 || amount <= 0) {
    toast('请输入大于 0 的 5 元整数倍');
    return;
  }
  try {
    state.preview = await api('/api/tasks/preview', { method: 'POST', body: JSON.stringify({ amount }) });
    renderPreview();
  } catch (e) {
    toast(e.message);
  }
}

async function executeTask() {
  if (!state.preview) return;
  try {
    await api('/api/tasks', { method: 'POST', body: JSON.stringify({ amount: state.preview.amount, confirmed: true }) });
    toast('任务已执行');
    state.preview = null;
    renderPreview();
    $('#amountInput').value = '';
    await loadAll();
  } catch (e) {
    toast(e.message);
  }
}

function fillAmount(amount) {
  $('#amountInput').value = amount;
}

function openAccountModal(account) {
  $('#accountModalTitle').textContent = account ? '编辑账号' : '新增账号';
  $('#accountIdInput').value = account?.id || '';
  $('#ownerNameInput').value = account?.owner_name || '';
  $('#loginNameInput').value = account?.login_name || '';
  $('#passwordInput').value = account?.password || '';
  $('#monthQuotaInput').value = account?.month_quota || 30;
  $('#remainCountInput').value = account?.remain_coupon_count ?? 30;
  $('#statusInput').value = account?.status || 'normal';
  $('#noteInput').value = account?.note || '';
  openModal('#accountModal');
}

window.editAccount = (id) => {
  const account = state.accounts.find(x => x.id === id);
  if (account) openAccountModal(account);
};

window.removeAccount = async (id) => {
  if (!confirm('确定删除这个账号吗？')) return;
  try {
    await api(`/api/accounts/${id}`, { method: 'DELETE' });
    toast('已删除');
    await loadAll();
  } catch (e) {
    toast(e.message);
  }
};

async function saveAccount() {
  const id = $('#accountIdInput').value;
  const payload = {
    owner_name: $('#ownerNameInput').value.trim(),
    login_name: $('#loginNameInput').value.trim(),
    password: $('#passwordInput').value,
    month_quota: Number($('#monthQuotaInput').value || 30),
    remain_coupon_count: Number($('#remainCountInput').value || 0),
    status: $('#statusInput').value,
    note: $('#noteInput').value.trim(),
  };
  try {
    if (id) {
      await api(`/api/accounts/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
      toast('已更新');
    } else {
      await api('/api/accounts', { method: 'POST', body: JSON.stringify(payload) });
      toast('已新增');
    }
    closeModal('#accountModal');
    await loadAll();
  } catch (e) {
    toast(e.message);
  }
}

async function saveConfig() {
  const payload = {
    target_url: $('#targetUrlInput').value.trim(),
    execution_mode: $('#executionModeSelect').value,
    require_confirmation: $('#requireConfirmInput').checked,
  };
  try {
    state.config = await api('/api/config', { method: 'POST', body: JSON.stringify(payload) });
    closeModal('#configModal');
    toast('配置已保存');
  } catch (e) {
    toast(e.message);
  }
}

async function resetMonth() {
  if (!confirm('确定执行月度重置吗？会把所有账号的剩余券重置为月度总券数。')) return;
  try {
    await api('/api/admin/reset-month', { method: 'POST', body: JSON.stringify({}) });
    toast('已重置');
    await loadAll();
  } catch (e) {
    toast(e.message);
  }
}

function bindEvents() {
  $$('.quick-buttons button').forEach(btn => btn.addEventListener('click', () => fillAmount(btn.dataset.amount)));
  $('#previewBtn').addEventListener('click', createPreview);
  $('#addAccountBtn').addEventListener('click', () => openAccountModal());
  $('#saveAccountBtn').addEventListener('click', saveAccount);
  $('#openConfigBtn').addEventListener('click', () => openModal('#configModal'));
  $('#saveConfigBtn').addEventListener('click', saveConfig);
  $('#refreshTasksBtn').addEventListener('click', loadAll);
  $('#resetMonthBtn').addEventListener('click', resetMonth);
  $$('[data-close]').forEach(btn => btn.addEventListener('click', () => closeModal(btn.dataset.close)));
}

(async function boot() {
  bindEvents();
  try {
    await loadAll();
  } catch (e) {
    toast(`加载失败：${e.message}`);
  }
})();
