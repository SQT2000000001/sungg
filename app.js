"use strict";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const nf = new Intl.NumberFormat("zh-CN");
const dtf = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const dateLabel = new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" });

const config = window.BREAKER_APP_CONFIG || {};
const configReady = Boolean(
  config.SUPABASE_URL &&
  config.SUPABASE_PUBLISHABLE_KEY &&
  !String(config.SUPABASE_URL).includes("YOUR_") &&
  !String(config.SUPABASE_PUBLISHABLE_KEY).includes("YOUR_")
);

const db = configReady && window.supabase
  ? window.supabase.createClient(config.SUPABASE_URL, config.SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    })
  : null;

const state = {
  user: null,
  breakers: [],
  latestLogs: [],
  trend: [],
  activeView: "dashboard",
  recordPage: 1,
  recordPageSize: 15,
  recordTotal: 0,
  recordRows: [],
  syncTimer: null,
  syncInterval: Number(localStorage.getItem("breakerSyncInterval") || 20),
  defaultOperator: localStorage.getItem("breakerDefaultOperator") || "",
  chartResizeObserver: null,
  loading: false
};

const viewMeta = {
  dashboard: ["高压断路器机械操作次数统计", "样机状态监控 · 操作数据追踪 · 寿命进度管理"],
  machines: ["样机管理", "样机档案、机械寿命目标与运行状态维护"],
  records: ["操作记录", "机械操作数据查询、修改与累计次数追溯"],
  analytics: ["统计分析", "样机操作量、完成率与状态分布对比"],
  backup: ["导出备份", "操作记录导出与完整数据归档"],
  settings: ["系统设置", "默认操作人与自动同步参数"],
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function errorText(error) {
  if (!error) return "发生未知错误";
  const message = error.message || error.error_description || String(error);
  const translations = [
    ["Invalid login credentials", "邮箱或密码不正确"],
    ["Email not confirmed", "该邮箱尚未完成验证"],
    ["User already registered", "该邮箱已注册"],
    ["duplicate key value", "样机编号已存在，请更换编号"],
    ["JWT expired", "登录已过期，请重新登录"],
    ["Failed to fetch", "无法连接 Supabase，请检查网络和 config.js 配置"],
  ];
  const match = translations.find(([key]) => message.includes(key));
  return match ? match[1] : message;
}

function toast(message, type = "success") {
  const item = document.createElement("div");
  item.className = `toast ${type}`;
  item.textContent = message;
  $("#toastStack").append(item);
  window.setTimeout(() => item.remove(), 3600);
}

function setButtonLoading(button, loading, loadingText = "处理中……") {
  if (!button) return;
  if (loading) {
    button.dataset.originalText = button.innerHTML;
    button.disabled = true;
    button.textContent = loadingText;
  } else {
    button.disabled = false;
    if (button.dataset.originalText) button.innerHTML = button.dataset.originalText;
  }
}

function toLocalInput(date = new Date()) {
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 19);
}

function localDateStartIso(dateString) {
  return new Date(`${dateString}T00:00:00`).toISOString();
}

function localDateEndIso(dateString) {
  const date = new Date(`${dateString}T00:00:00`);
  date.setDate(date.getDate() + 1);
  return date.toISOString();
}

function formatDateTime(value) {
  if (!value) return "—";
  return dtf.format(new Date(value)).replaceAll("/", "-");
}

function percentFor(breaker) {
  const target = Number(breaker.target_count || 0);
  if (target <= 0) return 0;
  return Math.max(0, Math.min(100, Number(breaker.operation_count || 0) / target * 100));
}

function progressColor(percent) {
  if (percent >= 100) return "#0e9f6e";
  if (percent >= 75) return "#2468e8";
  if (percent >= 50) return "#0b9d86";
  if (percent >= 25) return "#f59e0b";
  return "#ef4444";
}

function statusClass(status) {
  return ({ "运行中": "status-running", "已完成": "status-completed", "暂停": "status-paused", "检修中": "status-maintenance" })[status] || "status-paused";
}

function emptyRow(colspan, text) {
  return `<tr><td class="empty-row" colspan="${colspan}">${escapeHtml(text)}</td></tr>`;
}

function setSyncStatus(type, label) {
  const badge = $("#syncBadge");
  if (!badge) return;
  badge.className = `sync-badge ${type}`;
  badge.innerHTML = `<span class="live-dot"></span><span>${escapeHtml(label)}</span>`;
}

function updateSyncTime() {
  const now = new Date();
  $("#sidebarSyncTime").textContent = dtf.format(now).replaceAll("/", "-");
  setSyncStatus("", `云端已同步 · ${now.toLocaleTimeString("zh-CN", { hour12: false })}`);
}

async function ensureSession() {
  if (!db) {
    $("#loginHint").textContent = "尚未配置 Supabase。请在 config.js 中填写 Project URL 和 Publishable key。";
    return;
  }
  const { data, error } = await db.auth.getSession();
  if (error) toast(errorText(error), "error");
  if (data?.session?.user) await enterApp(data.session.user);
}

async function enterApp(user) {
  state.user = user;
  $("#authView").hidden = true;
  $("#appView").hidden = false;
  const displayName = user.user_metadata?.full_name || user.user_metadata?.name || user.email?.split("@")[0] || "用户";
  $("#userName").textContent = displayName;
  $("#userRole").textContent = user.user_metadata?.role || "运维工程师";
  if (!state.defaultOperator) {
    state.defaultOperator = displayName;
    localStorage.setItem("breakerDefaultOperator", displayName);
  }
  $("#quickOperator").value = state.defaultOperator;
  $("#settingOperator").value = state.defaultOperator;
  $("#settingInterval").value = String(state.syncInterval);
  await loadDashboardData(true);
  configureAutoSync();
}

function leaveApp() {
  state.user = null;
  state.breakers = [];
  state.latestLogs = [];
  clearInterval(state.syncTimer);
  state.syncTimer = null;
  $("#appView").hidden = true;
  $("#authView").hidden = false;
  $("#loginPassword").value = "";
}

async function loadDashboardData(showFeedback = false) {
  if (!db || state.loading) return;
  state.loading = true;
  setSyncStatus("syncing", "正在同步");
  try {
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const [breakersResult, todayResult, logsResult] = await Promise.all([
      db.from("breakers").select("*").order("created_at", { ascending: true }),
      db.from("operation_logs").select("operation_count").gte("operation_time", startToday).gt("operation_count", 0),
      db.from("operation_logs").select("id, breaker_id, breaker_code, voltage_level, operator_name, operation_count, cumulative_count, remark, operation_time, created_at").order("operation_time", { ascending: false }).order("created_at", { ascending: false }).limit(8)
    ]);
    if (breakersResult.error) throw breakersResult.error;
    if (todayResult.error) throw todayResult.error;
    if (logsResult.error) throw logsResult.error;

    state.breakers = breakersResult.data || [];
    state.latestLogs = logsResult.data || [];
    state.todayPositive = (todayResult.data || []).reduce((sum, row) => sum + Number(row.operation_count || 0), 0);

    populateMachineSelects();
    renderKpis();
    renderLifeProgress();
    renderDashboardMachines();
    renderDashboardLogs();
    renderMachineTable();
    renderAnalytics();
    await loadTrend();
    updateSyncTime();
    if (state.activeView === "records") await loadRecordPage();
    if (showFeedback) toast("云端数据已同步");
  } catch (error) {
    setSyncStatus("error", "同步失败");
    toast(errorText(error), "error");
    if (String(error?.message || "").includes("JWT")) leaveApp();
  } finally {
    state.loading = false;
  }
}

function renderKpis() {
  const totalOperations = state.breakers.reduce((sum, item) => sum + Number(item.operation_count || 0), 0);
  const completionValues = state.breakers.filter(item => Number(item.target_count || 0) > 0).map(percentFor);
  const average = completionValues.length ? completionValues.reduce((a,b) => a+b, 0) / completionValues.length : 0;
  $("#kpiTotalOperations").textContent = nf.format(totalOperations);
  $("#kpiMachineCount").textContent = nf.format(state.breakers.length);
  $("#kpiTodayCount").textContent = nf.format(state.todayPositive || 0);
  $("#kpiCompletion").textContent = `${average.toFixed(1)}%`;
  $("#dashboardMachineCount").textContent = `共 ${state.breakers.length} 台样机`;
  $("#machineTotalLabel").textContent = `共 ${state.breakers.length} 台`;
}

function populateMachineSelects() {
  const options = state.breakers.map(item => `<option value="${item.id}">${escapeHtml(item.asset_code)} · ${escapeHtml(item.voltage_level || "")}</option>`).join("");
  const targets = [$("#quickMachine"), $("#recordMachine")];
  targets.forEach((select, index) => {
    if (!select) return;
    const current = select.value;
    select.innerHTML = `${index === 0 ? '<option value="">请选择样机</option>' : ''}${options}`;
    if ([...select.options].some(option => option.value === current)) select.value = current;
  });
  const trend = $("#trendMachineSelect");
  const currentTrend = trend.value;
  trend.innerHTML = `<option value="">全部样机</option>${options}`;
  if ([...trend.options].some(option => option.value === currentTrend)) trend.value = currentTrend;
}

function renderLifeProgress() {
  const root = $("#lifeProgressList");
  if (!state.breakers.length) {
    root.innerHTML = `<div class="empty-row">暂无样机，请先新增样机</div>`;
    return;
  }
  const items = [...state.breakers].sort((a,b) => percentFor(b) - percentFor(a)).slice(0, 4);
  root.innerHTML = items.map(item => {
    const p = percentFor(item);
    const color = progressColor(p);
    return `<div class="life-item">
      <div class="life-ring" style="--p:${p};--ring:${color}"><strong>${p.toFixed(1)}%</strong></div>
      <div class="life-info"><div class="life-top"><strong>${escapeHtml(item.asset_code)}</strong><span>${nf.format(item.operation_count)} / ${nf.format(item.target_count)} 次</span></div>
      <p>${escapeHtml(item.voltage_level)} · ${escapeHtml(item.product_series || "未设置系列")} · ${escapeHtml(item.mechanism_type || "未设置机构")}</p>
      <div class="mini-progress" style="--bar-color:${color}"><i style="width:${p}%"></i></div></div>
    </div>`;
  }).join("");
}

function filterMachines(searchValue, statusValue) {
  const search = String(searchValue || "").trim().toLowerCase();
  return state.breakers.filter(item => {
    const text = [item.asset_code, item.voltage_level, item.product_series, item.mechanism_type, item.operating_environment, item.note].join(" ").toLowerCase();
    return (!search || text.includes(search)) && (!statusValue || item.status === statusValue);
  });
}

function machineRow(item, dashboard = false) {
  const p = percentFor(item);
  const color = progressColor(p);
  const action = `<button class="table-action" data-edit-machine="${item.id}" title="编辑样机"><svg><use href="#i-edit"></use></svg></button>`;
  if (dashboard) {
    return `<tr><td><strong>${escapeHtml(item.asset_code)}</strong></td><td>${escapeHtml(item.voltage_level)}</td><td>${escapeHtml(item.product_series || "—")}</td><td>${escapeHtml(item.mechanism_type || "—")}</td><td>${nf.format(item.operation_count)}</td><td class="completion-cell"><span>${p.toFixed(1)}%</span><div class="table-progress" style="--bar-color:${color}"><i style="width:${p}%"></i></div></td><td><span class="status-chip ${statusClass(item.status)}">${escapeHtml(item.status)}</span></td><td>${action}</td></tr>`;
  }
  return `<tr><td><strong>${escapeHtml(item.asset_code)}</strong></td><td>${escapeHtml(item.voltage_level)}</td><td>${escapeHtml(item.product_series || "—")}</td><td>${escapeHtml(item.mechanism_type || "—")}</td><td>${escapeHtml(item.operating_environment || "—")}</td><td>${nf.format(item.operation_count)}</td><td>${nf.format(item.target_count)}</td><td class="completion-cell"><span>${p.toFixed(1)}%</span><div class="table-progress" style="--bar-color:${color}"><i style="width:${p}%"></i></div></td><td><span class="status-chip ${statusClass(item.status)}">${escapeHtml(item.status)}</span></td><td>${action}</td></tr>`;
}

function renderDashboardMachines() {
  const list = filterMachines($("#dashboardMachineSearch").value, $("#dashboardMachineStatus").value).slice(0, 6);
  $("#dashboardMachineBody").innerHTML = list.length ? list.map(item => machineRow(item, true)).join("") : emptyRow(8, "没有符合条件的样机");
}

function renderMachineTable() {
  const list = filterMachines($("#machineSearch").value, $("#machineStatusFilter").value);
  $("#machineBody").innerHTML = list.length ? list.map(item => machineRow(item, false)).join("") : emptyRow(10, "没有符合条件的样机");
}

function logRow(item, dashboard = false) {
  const delta = Number(item.operation_count || 0);
  const deltaClass = delta >= 0 ? "delta-positive" : "delta-negative";
  const deltaText = `${delta > 0 ? "+" : ""}${nf.format(delta)}`;
  const action = `<button class="table-action" data-edit-record="${item.id}" title="编辑记录"><svg><use href="#i-edit"></use></svg></button>`;
  if (dashboard) {
    return `<tr><td>${formatDateTime(item.operation_time)}</td><td><strong>${escapeHtml(item.breaker_code)}</strong></td><td>${escapeHtml(item.operator_name)}</td><td class="${deltaClass}">${deltaText}</td><td title="${escapeHtml(item.remark)}">${escapeHtml(item.remark || "—")}</td><td>${action}</td></tr>`;
  }
  return `<tr><td>${formatDateTime(item.operation_time)}</td><td><strong>${escapeHtml(item.breaker_code)}</strong></td><td>${escapeHtml(item.voltage_level || "—")}</td><td>${escapeHtml(item.operator_name)}</td><td class="${deltaClass}">${deltaText}</td><td>${nf.format(item.cumulative_count)}</td><td title="${escapeHtml(item.remark)}">${escapeHtml(item.remark || "—")}</td><td>${action}</td></tr>`;
}

function renderDashboardLogs() {
  $("#dashboardLogCount").textContent = `最近 ${state.latestLogs.length} 条记录`;
  $("#dashboardLogBody").innerHTML = state.latestLogs.length ? state.latestLogs.map(item => logRow(item, true)).join("") : emptyRow(6, "暂无操作记录");
}

async function loadTrend() {
  if (!db) return;
  const breakerId = $("#trendMachineSelect").value || null;
  const { data, error } = await db.rpc("get_operation_trend", { p_days: 7, p_breaker_id: breakerId });
  if (error) throw error;
  state.trend = (data || []).map(row => ({ date: row.operation_date, value: Number(row.positive_count || 0) }));
  drawTrendChart();
  const total = state.trend.reduce((sum, row) => sum + row.value, 0);
  const today = state.trend.at(-1)?.value || 0;
  $("#trendNarrative").innerHTML = total
    ? `近7日共完成 <strong>${nf.format(total)}</strong> 次机械操作；今日完成 <strong>${nf.format(today)}</strong> 次。`
    : "近7日暂无机械操作记录。";
}

function drawTrendChart() {
  const canvas = $("#trendCanvas");
  const empty = $("#chartEmpty");
  const values = state.trend.map(item => item.value);
  const hasData = values.some(value => value > 0);
  empty.hidden = hasData;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const w = rect.width, h = rect.height;
  ctx.clearRect(0, 0, w, h);
  const pad = { left: 48, right: 18, top: 22, bottom: 30 };
  const cw = w - pad.left - pad.right;
  const ch = h - pad.top - pad.bottom;
  const rawMax = Math.max(...values, 1);
  const magnitude = 10 ** Math.floor(Math.log10(rawMax));
  const max = Math.ceil(rawMax / magnitude) * magnitude;
  const yTicks = 4;
  ctx.font = "9px Inter, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let i = 0; i <= yTicks; i++) {
    const y = pad.top + ch * i / yTicks;
    const value = max * (1 - i / yTicks);
    ctx.strokeStyle = "#e8edf4";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
    ctx.fillStyle = "#7d899d";
    ctx.fillText(nf.format(Math.round(value)), pad.left - 9, y);
  }
  const points = state.trend.map((item, index) => {
    const x = pad.left + (state.trend.length === 1 ? cw / 2 : cw * index / (state.trend.length - 1));
    const y = pad.top + ch - (item.value / max) * ch;
    return { x, y, ...item };
  });
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  points.forEach(point => {
    ctx.fillStyle = "#738199";
    ctx.fillText(dateLabel.format(new Date(`${point.date}T00:00:00`)), point.x, h - 22);
  });
  if (!points.length) return;
  const gradient = ctx.createLinearGradient(0, pad.top, 0, pad.top + ch);
  gradient.addColorStop(0, "rgba(36,104,232,.24)");
  gradient.addColorStop(1, "rgba(36,104,232,.015)");
  ctx.beginPath();
  ctx.moveTo(points[0].x, pad.top + ch);
  points.forEach((point, index) => index === 0 ? ctx.lineTo(point.x, point.y) : ctx.lineTo(point.x, point.y));
  ctx.lineTo(points.at(-1).x, pad.top + ch);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.beginPath();
  points.forEach((point, index) => index === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y));
  ctx.strokeStyle = "#2468e8";
  ctx.lineWidth = 2.5;
  ctx.stroke();
  points.forEach(point => {
    ctx.beginPath(); ctx.arc(point.x, point.y, 4, 0, Math.PI * 2); ctx.fillStyle = "#fff"; ctx.fill(); ctx.strokeStyle = "#2468e8"; ctx.lineWidth = 2; ctx.stroke();
    if (point.value > 0) {
      ctx.fillStyle = "#29436f"; ctx.font = "bold 9px Inter, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
      ctx.fillText(nf.format(point.value), point.x, point.y - 8);
    }
  });
}

async function loadRecordPage() {
  if (!db) return;
  const page = state.recordPage;
  const from = (page - 1) * state.recordPageSize;
  const to = from + state.recordPageSize - 1;
  let query = db.from("operation_logs")
    .select("id, breaker_id, breaker_code, voltage_level, operator_name, operation_count, cumulative_count, remark, operation_time, created_at", { count: "exact" })
    .order("operation_time", { ascending: false })
    .order("created_at", { ascending: false });
  const term = $("#recordSearch").value.trim().replace(/[(),]/g, " ");
  if (term) query = query.or(`breaker_code.ilike.%${term}%,operator_name.ilike.%${term}%,remark.ilike.%${term}%`);
  const start = $("#recordStartDate").value;
  const end = $("#recordEndDate").value;
  if (start) query = query.gte("operation_time", localDateStartIso(start));
  if (end) query = query.lt("operation_time", localDateEndIso(end));
  const { data, error, count } = await query.range(from, to);
  if (error) throw error;
  state.recordRows = data || [];
  state.recordTotal = count || 0;
  $("#recordBody").innerHTML = state.recordRows.length ? state.recordRows.map(item => logRow(item, false)).join("") : emptyRow(8, "没有符合条件的操作记录");
  const totalPages = Math.max(1, Math.ceil(state.recordTotal / state.recordPageSize));
  if (state.recordPage > totalPages) { state.recordPage = totalPages; return loadRecordPage(); }
  $("#recordCountLabel").textContent = `共 ${nf.format(state.recordTotal)} 条`;
  $("#recordPageLabel").textContent = `第 ${state.recordPage} / ${totalPages} 页`;
  $("#recordPrev").disabled = state.recordPage <= 1;
  $("#recordNext").disabled = state.recordPage >= totalPages;
}

function renderAnalytics() {
  const sorted = [...state.breakers].sort((a,b) => Number(b.operation_count) - Number(a.operation_count));
  const max = Math.max(...sorted.map(item => Number(item.operation_count || 0)), 1);
  $("#barAnalytics").innerHTML = sorted.length ? sorted.map(item => `<div class="bar-item"><strong>${escapeHtml(item.asset_code)}</strong><div class="bar-track"><i style="width:${Number(item.operation_count || 0) / max * 100}%"></i></div><span>${nf.format(item.operation_count)} 次</span></div>`).join("") : `<div class="empty-row">暂无样机数据</div>`;
  const statuses = ["运行中", "已完成", "暂停", "检修中"];
  $("#statusAnalytics").innerHTML = statuses.map(status => {
    const count = state.breakers.filter(item => item.status === status).length;
    return `<div class="status-row"><span class="status-chip ${statusClass(status)}">${status}</span><strong>${count}</strong></div>`;
  }).join("");
}

function switchView(name) {
  state.activeView = name;
  $$(".nav-item").forEach(item => item.classList.toggle("active", item.dataset.view === name));
  $$(".view-panel").forEach(panel => panel.classList.toggle("active", panel.id === `view-${name}`));
  $("#pageTitle").textContent = viewMeta[name][0];
  $("#pageSubtitle").textContent = viewMeta[name][1];
  closeSidebar();
  if (name === "records") loadRecordPage().catch(error => toast(errorText(error), "error"));
  if (name === "dashboard") window.setTimeout(drawTrendChart, 30);
}

function openSidebar() {
  $("#sidebar").classList.add("open");
  $("#sidebarMask").hidden = false;
}
function closeSidebar() {
  $("#sidebar").classList.remove("open");
  $("#sidebarMask").hidden = true;
}

function openMachineDialog(id = null) {
  const dialog = $("#machineDialog");
  $("#machineForm").reset();
  $("#machineTarget").value = "10000";
  $("#machineInitial").value = "0";
  $("#machineInitialOperator").value = state.defaultOperator;
  $("#machineId").value = id || "";
  const editing = Boolean(id);
  $("#machineDialogTitle").textContent = editing ? "编辑样机" : "新增样机";
  $("#machineInitial").disabled = editing;
  $("#machineInitialOperator").disabled = editing;
  if (editing) {
    const item = state.breakers.find(row => row.id === id);
    if (!item) return;
    $("#machineCode").value = item.asset_code || "";
    $("#machineVoltage").value = item.voltage_level || "";
    $("#machineSeries").value = item.product_series || "";
    $("#machineMechanism").value = item.mechanism_type || "";
    $("#machineEnvironment").value = item.operating_environment || "户内";
    $("#machineStatus").value = item.status || "运行中";
    $("#machineTarget").value = item.target_count || 0;
    $("#machineNote").value = item.note || "";
  }
  dialog.showModal();
  setTimeout(() => $("#machineCode").focus(), 0);
}

function openRecordDialog(id) {
  const item = [...state.latestLogs, ...state.recordRows].find(row => row.id === id);
  if (!item) { toast("未找到该操作记录，请刷新后重试", "error"); return; }
  populateMachineSelects();
  $("#recordId").value = item.id;
  $("#recordMachine").value = item.breaker_id;
  $("#recordTime").value = toLocalInput(new Date(item.operation_time));
  $("#recordOperator").value = item.operator_name || "";
  $("#recordDelta").value = item.operation_count;
  $("#recordRemark").value = item.remark || "";
  $("#recordDialog").showModal();
}

async function submitMachine(event) {
  event.preventDefault();
  const button = $("#machineSaveBtn");
  setButtonLoading(button, true);
  try {
    const id = $("#machineId").value;
    const shared = {
      p_asset_code: $("#machineCode").value.trim(),
      p_voltage_level: $("#machineVoltage").value.trim(),
      p_product_series: $("#machineSeries").value.trim(),
      p_mechanism_type: $("#machineMechanism").value.trim(),
      p_operating_environment: $("#machineEnvironment").value,
      p_status: $("#machineStatus").value,
      p_target_count: Number($("#machineTarget").value || 0),
      p_note: $("#machineNote").value.trim()
    };
    let result;
    if (id) {
      result = await db.rpc("update_breaker", { p_breaker_id: id, ...shared });
    } else {
      result = await db.rpc("create_breaker", {
        ...shared,
        p_initial_count: Number($("#machineInitial").value || 0),
        p_initial_operator: $("#machineInitialOperator").value.trim(),
        p_initial_time: new Date().toISOString()
      });
    }
    if (result.error) throw result.error;
    $("#machineDialog").close();
    toast(id ? "样机信息已更新" : "样机已新增");
    await loadDashboardData();
  } catch (error) { toast(errorText(error), "error"); }
  finally { setButtonLoading(button, false); }
}

async function submitQuickEntry(event) {
  event.preventDefault();
  const button = $("#quickSaveBtn");
  setButtonLoading(button, true);
  try {
    const delta = Number($("#quickCount").value);
    if (!Number.isInteger(delta) || delta === 0) throw new Error("操作次数必须为非零整数");
    const operator = $("#quickOperator").value.trim();
    const { error } = await db.rpc("record_breaker_operation", {
      p_breaker_id: $("#quickMachine").value,
      p_operation_count: delta,
      p_operator_name: operator,
      p_remark: $("#quickRemark").value.trim(),
      p_operation_time: new Date($("#quickTime").value).toISOString()
    });
    if (error) throw error;
    state.defaultOperator = operator;
    localStorage.setItem("breakerDefaultOperator", operator);
    $("#quickCount").value = "";
    $("#quickRemark").value = "";
    $("#quickTime").value = toLocalInput();
    toast("操作记录已保存");
    await loadDashboardData();
  } catch (error) { toast(errorText(error), "error"); }
  finally { setButtonLoading(button, false); }
}

async function submitRecordEdit(event) {
  event.preventDefault();
  const button = $("#recordSaveBtn");
  setButtonLoading(button, true);
  try {
    const delta = Number($("#recordDelta").value);
    if (!Number.isInteger(delta) || delta === 0) throw new Error("操作次数必须为非零整数");
    const { error } = await db.rpc("update_breaker_operation", {
      p_log_id: $("#recordId").value,
      p_breaker_id: $("#recordMachine").value,
      p_operation_count: delta,
      p_operator_name: $("#recordOperator").value.trim(),
      p_remark: $("#recordRemark").value.trim(),
      p_operation_time: new Date($("#recordTime").value).toISOString()
    });
    if (error) throw error;
    $("#recordDialog").close();
    toast("操作记录已更新，累计次数已重新计算");
    await loadDashboardData();
    if (state.activeView === "records") await loadRecordPage();
  } catch (error) { toast(errorText(error), "error"); }
  finally { setButtonLoading(button, false); }
}

async function fetchAll(table, columns, orderColumn) {
  const rows = [];
  const chunk = 1000;
  for (let from = 0; ; from += chunk) {
    const { data, error } = await db.from(table).select(columns).order(orderColumn, { ascending: true }).range(from, from + chunk - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < chunk) break;
    if (from > 100000) throw new Error("导出记录超过安全上限，请缩小数据范围");
  }
  return rows;
}

function downloadBlob(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvCell(value) {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

async function exportCsv() {
  try {
    toast("正在整理操作记录……");
    const rows = await fetchAll("operation_logs", "breaker_code, voltage_level, operator_name, operation_count, cumulative_count, remark, operation_time, created_at, updated_at", "operation_time");
    const headers = ["操作时间", "样机编号", "电压等级", "操作人", "操作次数", "累计次数", "备注", "创建时间", "修改时间"];
    const lines = [headers.map(csvCell).join(","), ...rows.map(row => [formatDateTime(row.operation_time), row.breaker_code, row.voltage_level, row.operator_name, row.operation_count, row.cumulative_count, row.remark, formatDateTime(row.created_at), formatDateTime(row.updated_at)].map(csvCell).join(","))];
    downloadBlob(`断路器操作记录_${new Date().toISOString().slice(0,10)}.csv`, `\ufeff${lines.join("\r\n")}`, "text/csv;charset=utf-8");
    toast(`已导出 ${rows.length} 条操作记录`);
  } catch (error) { toast(errorText(error), "error"); }
}

async function exportJson() {
  try {
    toast("正在生成完整备份……");
    const logs = await fetchAll("operation_logs", "*", "operation_time");
    const payload = { version: "6.0.0", exported_at: new Date().toISOString(), breakers: state.breakers, operation_logs: logs };
    downloadBlob(`断路器统计备份_${new Date().toISOString().slice(0,10)}.json`, JSON.stringify(payload, null, 2), "application/json;charset=utf-8");
    toast("完整 JSON 备份已导出");
  } catch (error) { toast(errorText(error), "error"); }
}

function configureAutoSync() {
  clearInterval(state.syncTimer);
  state.syncTimer = null;
  if (state.syncInterval > 0) {
    state.syncTimer = setInterval(() => loadDashboardData(false), state.syncInterval * 1000);
  }
}

function debounce(fn, delay = 250) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); };
}

function bindEvents() {
  $("#quickTime").value = toLocalInput();
  $("#loginForm").addEventListener("submit", async event => {
    event.preventDefault();
    if (!db) { toast("请先完成 config.js 配置", "error"); return; }
    const button = $("#loginBtn");
    setButtonLoading(button, true, "正在登录……");
    const { data, error } = await db.auth.signInWithPassword({ email: $("#loginEmail").value.trim(), password: $("#loginPassword").value });
    setButtonLoading(button, false);
    if (error) return toast(errorText(error), "error");
    await enterApp(data.user);
  });
  $("#logoutBtn").addEventListener("click", async () => { if (db) await db.auth.signOut(); leaveApp(); });
  $$(".nav-item").forEach(item => item.addEventListener("click", () => switchView(item.dataset.view)));
  $$('[data-go]').forEach(item => item.addEventListener("click", () => switchView(item.dataset.go)));
  $("#mobileMenuBtn").addEventListener("click", openSidebar);
  $("#sidebarMask").addEventListener("click", closeSidebar);
  $("#dashboardRefreshBtn").addEventListener("click", () => loadDashboardData(true));
  $("#recordsRefreshBtn").addEventListener("click", () => loadRecordPage().catch(error => toast(errorText(error), "error")));
  $("#addMachineBtn").addEventListener("click", () => openMachineDialog());
  $("#machineForm").addEventListener("submit", submitMachine);
  $("#quickEntryForm").addEventListener("submit", submitQuickEntry);
  $("#recordEditForm").addEventListener("submit", submitRecordEdit);
  $$(".modal-close").forEach(button => button.addEventListener("click", () => button.closest("dialog").close()));
  [$("#machineDialog"), $("#recordDialog")].forEach(dialog => dialog.addEventListener("click", event => { if (event.target === dialog) dialog.close(); }));

  document.addEventListener("click", event => {
    const machineButton = event.target.closest("[data-edit-machine]");
    if (machineButton) openMachineDialog(machineButton.dataset.editMachine);
    const recordButton = event.target.closest("[data-edit-record]");
    if (recordButton) openRecordDialog(recordButton.dataset.editRecord);
  });

  $("#trendMachineSelect").addEventListener("change", () => loadTrend().catch(error => toast(errorText(error), "error")));
  $("#dashboardMachineSearch").addEventListener("input", renderDashboardMachines);
  $("#dashboardMachineStatus").addEventListener("change", renderDashboardMachines);
  $("#machineSearch").addEventListener("input", renderMachineTable);
  $("#machineStatusFilter").addEventListener("change", renderMachineTable);

  const reloadRecords = debounce(() => { state.recordPage = 1; loadRecordPage().catch(error => toast(errorText(error), "error")); });
  $("#recordSearch").addEventListener("input", reloadRecords);
  $("#recordStartDate").addEventListener("change", reloadRecords);
  $("#recordEndDate").addEventListener("change", reloadRecords);
  $("#recordResetFilters").addEventListener("click", () => { $("#recordSearch").value = ""; $("#recordStartDate").value = ""; $("#recordEndDate").value = ""; state.recordPage = 1; loadRecordPage().catch(error => toast(errorText(error), "error")); });
  $("#recordPrev").addEventListener("click", () => { if (state.recordPage > 1) { state.recordPage--; loadRecordPage().catch(error => toast(errorText(error), "error")); } });
  $("#recordNext").addEventListener("click", () => { const max = Math.ceil(state.recordTotal / state.recordPageSize); if (state.recordPage < max) { state.recordPage++; loadRecordPage().catch(error => toast(errorText(error), "error")); } });

  $("#exportCsvBtn").addEventListener("click", exportCsv);
  $("#topExportBtn").addEventListener("click", exportCsv);
  $("#exportJsonBtn").addEventListener("click", exportJson);
  $("#settingsForm").addEventListener("submit", event => {
    event.preventDefault();
    state.defaultOperator = $("#settingOperator").value.trim();
    state.syncInterval = Number($("#settingInterval").value || 0);
    localStorage.setItem("breakerDefaultOperator", state.defaultOperator);
    localStorage.setItem("breakerSyncInterval", String(state.syncInterval));
    $("#quickOperator").value = state.defaultOperator;
    configureAutoSync();
    toast("系统设置已保存");
  });

  if (window.ResizeObserver) {
    state.chartResizeObserver = new ResizeObserver(() => { if (state.activeView === "dashboard") drawTrendChart(); });
    state.chartResizeObserver.observe($("#trendCanvas"));
  } else window.addEventListener("resize", debounce(drawTrendChart, 120));
}

async function init() {
  bindEvents();
  if (db) {
    db.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT") leaveApp();
      if (event === "TOKEN_REFRESHED" && session?.user) state.user = session.user;
    });
  }
  await ensureSession();
}

init().catch(error => toast(errorText(error), "error"));
