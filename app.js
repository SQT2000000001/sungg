import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

/*
 * Supabase 前端配置：Publishable key 可以用于浏览器前端。
 * 禁止在此填写 sb_secret_... 或 service_role key。
 */
const SUPABASE_URL = "https://bsisdwurajedsiwqtrvz.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_N1Q4bYnrH7LcHlPTKWcy5g_35ihhwbs";
const AUTO_REFRESH_MS = 20_000;
const LAST_OPERATOR_KEY = "breakerCounter.lastOperator";

const isConfigured =
  /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(SUPABASE_URL) &&
  !SUPABASE_PUBLISHABLE_KEY.includes("YOUR_") &&
  SUPABASE_PUBLISHABLE_KEY.length > 20;

const supabase = isConfigured
  ? createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    })
  : null;

const state = {
  breakers: [],
  logs: [],
  session: null,
  loading: false
};

let selectedBreakerId = null;
let selectedLogId = null;
let refreshTimer = null;
let messageTimer = null;
let chartResizeTimer = null;

const $ = (selector) => document.querySelector(selector);
const authMain = $("#authMain");
const appMain = $("#appMain");
const onlineActions = $("#onlineActions");
const loginForm = $("#loginForm");
const loginButton = $("#loginBtn");
const breakerForm = $("#breakerForm");
const breakerList = $("#breakerList");
const template = $("#breakerCardTemplate");
const manualDialog = $("#manualDialog");
const manualForm = $("#manualForm");
const editDialog = $("#editDialog");
const editForm = $("#editForm");
const editLogDialog = $("#editLogDialog");
const editLogForm = $("#editLogForm");

function uid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function toInt(value, fallback = 0) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(Number(value) || 0);
}

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);
}

function localDateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function toDateTimeLocalValue(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 19);
}

function dateTimeLocalToIso(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function getLastNDays(count) {
  const days = [];
  const formatter = new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" });
  for (let i = count - 1; i >= 0; i -= 1) {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() - i);
    days.push({
      key: localDateKey(date),
      label: formatter.format(date),
      date
    });
  }
  return days;
}

function setConnectionStatus(text, type = "success") {
  const element = $("#connectionStatus");
  element.textContent = text;
  element.classList.toggle("loading", type === "loading");
  element.classList.toggle("error", type === "error");
}

function showMessage(message, type = "info", timeoutMs = 5000) {
  const bar = $("#messageBar");
  window.clearTimeout(messageTimer);
  bar.textContent = message;
  bar.className = `message-bar ${type === "info" ? "" : type}`.trim();
  bar.hidden = false;
  if (timeoutMs > 0) {
    messageTimer = window.setTimeout(() => {
      bar.hidden = true;
    }, timeoutMs);
  }
}

function setButtonBusy(button, busy, busyText, normalText) {
  if (!button) return;
  button.disabled = busy;
  button.textContent = busy ? busyText : normalText;
}

function requireConfiguredClient() {
  if (supabase) return true;
  showMessage(
    "尚未配置 Supabase。请先在 app.js 顶部填写 Project URL 和 Publishable key。",
    "error",
    0
  );
  return false;
}

function getDefaultOperator() {
  const stored = window.localStorage.getItem(LAST_OPERATOR_KEY)?.trim();
  if (stored) return stored;
  const email = state.session?.user?.email || "";
  return email.includes("@") ? email.split("@")[0] : email;
}

function saveDefaultOperator(operatorName) {
  const name = String(operatorName || "").trim();
  if (name) window.localStorage.setItem(LAST_OPERATOR_KEY, name);
}

function mapBreaker(row) {
  return {
    id: row.id,
    name: row.name,
    model: row.model || "",
    target: Number(row.target) || 0,
    count: Number(row.count) || 0,
    note: row.note || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapLog(row) {
  return {
    id: row.id,
    time: row.created_at,
    updatedAt: row.updated_at || row.created_at,
    breakerId: row.breaker_id,
    breakerName: row.breaker_name,
    operatorName: row.operator_name || "未记录",
    delta: Number(row.delta) || 0,
    totalAfter: Number(row.total_after) || 0,
    reason: row.reason || ""
  };
}

async function loadData({ silent = false } = {}) {
  if (!supabase || !state.session || state.loading) return;
  state.loading = true;
  if (!silent) setConnectionStatus("正在同步云端数据……", "loading");

  try {
    const [breakerResult, logResult] = await Promise.all([
      supabase
        .from("breakers")
        .select("id,name,model,target,count,note,created_at,updated_at")
        .order("created_at", { ascending: false }),
      supabase
        .from("operation_logs")
        .select("id,breaker_id,breaker_name,operator_name,delta,total_after,reason,created_at,updated_at")
        .order("created_at", { ascending: false })
        .limit(3000)
    ]);

    if (breakerResult.error) throw breakerResult.error;
    if (logResult.error) throw logResult.error;

    state.breakers = (breakerResult.data || []).map(mapBreaker);
    state.logs = (logResult.data || []).map(mapLog);
    render();
    setConnectionStatus(`云端已同步 · ${formatDateTime(new Date())}`, "success");
  } catch (error) {
    console.error("读取云端数据失败：", error);
    setConnectionStatus("云端同步失败", "error");
    showMessage(`读取数据失败：${friendlyError(error)}`, "error", 0);
  } finally {
    state.loading = false;
  }
}

function friendlyError(error) {
  const message = String(error?.message || error || "未知错误");
  if (/Invalid API key|No API key/i.test(message)) return "Supabase Publishable key 不正确。";
  if (/relation .* does not exist/i.test(message)) return "数据库表尚未创建，请先执行数据库脚本。";
  if (/operator_name|updated_at.*operation_logs|column .* does not exist/i.test(message)) {
    return "数据库尚未升级，请先在 Supabase SQL Editor 执行 database-upgrade-v3.sql。";
  }
  if (/function .*adjust_breaker_count.*does not exist|Could not find the function/i.test(message)) {
    return "计数函数尚未升级，请执行 database-upgrade-v3.sql。";
  }
  if (/row-level security|permission denied|not allowed/i.test(message)) {
    return "数据库权限不足，请检查 RLS 策略和当前登录账号。";
  }
  if (/Failed to fetch|NetworkError|fetch/i.test(message)) {
    return "网络连接失败，请检查网络、Project URL 和浏览器控制台。";
  }
  return message;
}

function positiveSum(logs) {
  return logs.reduce((sum, log) => sum + (log.delta > 0 ? log.delta : 0), 0);
}

function logsForBreaker(breakerId) {
  return state.logs.filter((log) => log.breakerId === breakerId);
}

function renderSummary() {
  const totalBreakers = state.breakers.length;
  const totalOperations = state.breakers.reduce((sum, item) => sum + item.count, 0);
  const today = localDateKey();
  const todayOperations = positiveSum(state.logs.filter((log) => localDateKey(log.time) === today));
  const finishedBreakers = state.breakers.filter(
    (item) => item.target > 0 && item.count >= item.target
  ).length;

  $("#totalBreakers").textContent = formatNumber(totalBreakers);
  $("#totalOperations").textContent = formatNumber(totalOperations);
  $("#todayOperations").textContent = formatNumber(todayOperations);
  $("#finishedBreakers").textContent = formatNumber(finishedBreakers);
}

function renderMachineSummary() {
  const container = $("#machineSummaryGrid");
  container.replaceChildren();
  container.classList.toggle("empty-state", state.breakers.length === 0);

  if (!state.breakers.length) {
    container.textContent = "暂无样机统计数据。";
    return;
  }

  const today = localDateKey();
  const last7Keys = new Set(getLastNDays(7).map((item) => item.key));

  for (const breaker of state.breakers) {
    const breakerLogs = logsForBreaker(breaker.id);
    const todayCount = positiveSum(breakerLogs.filter((log) => localDateKey(log.time) === today));
    const sevenDayCount = positiveSum(
      breakerLogs.filter((log) => last7Keys.has(localDateKey(log.time)))
    );
    const target = breaker.target || 0;
    const percent = target > 0 ? Math.min(100, Math.round((breaker.count / target) * 100)) : 0;

    const card = document.createElement("article");
    card.className = "machine-summary-card";

    const title = document.createElement("h3");
    title.textContent = breaker.name;
    const model = document.createElement("p");
    model.className = "model";
    model.textContent = breaker.model || "未填写型号";

    const metrics = document.createElement("div");
    metrics.className = "machine-metrics";
    const metricData = [
      ["当前累计", formatNumber(breaker.count)],
      ["今日新增", formatNumber(todayCount)],
      ["近7日新增", formatNumber(sevenDayCount)]
    ];

    for (const [label, value] of metricData) {
      const metric = document.createElement("div");
      metric.className = "machine-metric";
      const span = document.createElement("span");
      span.textContent = label;
      const strong = document.createElement("strong");
      strong.textContent = value;
      metric.append(span, strong);
      metrics.appendChild(metric);
    }

    const targetWrap = document.createElement("div");
    targetWrap.className = "machine-target";
    const head = document.createElement("div");
    head.className = "progress-head";
    const targetText = document.createElement("span");
    targetText.textContent = target > 0 ? `目标：${formatNumber(target)} 次` : "未设置目标次数";
    const targetPercent = document.createElement("span");
    targetPercent.textContent = target > 0 ? `${percent}%` : "-";
    head.append(targetText, targetPercent);
    const bar = document.createElement("div");
    bar.className = "progress-bar";
    const fill = document.createElement("div");
    fill.style.width = `${percent}%`;
    bar.appendChild(fill);
    targetWrap.append(head, bar);

    card.append(title, model, metrics, targetWrap);
    container.appendChild(card);
  }
}

function renderTrendFilter() {
  const select = $("#trendBreakerFilter");
  const previous = select.value;
  select.replaceChildren();

  const allOption = document.createElement("option");
  allOption.value = "all";
  allOption.textContent = "全部样机";
  select.appendChild(allOption);

  for (const breaker of state.breakers) {
    const option = document.createElement("option");
    option.value = breaker.id;
    option.textContent = breaker.name;
    select.appendChild(option);
  }

  select.value = state.breakers.some((item) => item.id === previous) ? previous : "all";
}

function getTrendValues() {
  const selectedId = $("#trendBreakerFilter").value;
  const days = getLastNDays(7);
  const values = days.map((day) =>
    positiveSum(
      state.logs.filter((log) => {
        const matchesBreaker = selectedId === "all" || log.breakerId === selectedId;
        return matchesBreaker && localDateKey(log.time) === day.key;
      })
    )
  );
  return { selectedId, days, values };
}

function renderTrendChart() {
  const canvas = $("#trendChart");
  const summary = $("#trendSummary");
  const { selectedId, days, values } = getTrendValues();
  const width = Math.max(320, canvas.parentElement?.clientWidth || canvas.clientWidth || 800);
  const height = window.innerWidth <= 620 ? 280 : 320;
  const dpr = Math.max(1, window.devicePixelRatio || 1);

  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const margin = { left: 54, right: 20, top: 24, bottom: 50 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const maxValue = Math.max(1, ...values);
  const roundedMax = maxValue <= 5 ? 5 : Math.ceil(maxValue / 5) * 5;

  ctx.font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.textBaseline = "middle";
  ctx.strokeStyle = "#e5e7eb";
  ctx.fillStyle = "#64748b";
  ctx.lineWidth = 1;

  const gridLines = 5;
  for (let i = 0; i <= gridLines; i += 1) {
    const ratio = i / gridLines;
    const y = margin.top + plotHeight - ratio * plotHeight;
    const value = Math.round(ratio * roundedMax);
    ctx.beginPath();
    ctx.moveTo(margin.left, y);
    ctx.lineTo(width - margin.right, y);
    ctx.stroke();
    ctx.textAlign = "right";
    ctx.fillText(formatNumber(value), margin.left - 9, y);
  }

  const slotWidth = plotWidth / days.length;
  const barWidth = Math.min(52, slotWidth * 0.55);
  const points = [];

  values.forEach((value, index) => {
    const xCenter = margin.left + slotWidth * index + slotWidth / 2;
    const barHeight = (value / roundedMax) * plotHeight;
    const y = margin.top + plotHeight - barHeight;

    const gradient = ctx.createLinearGradient(0, y, 0, margin.top + plotHeight);
    gradient.addColorStop(0, "#2154d8");
    gradient.addColorStop(1, "#8ab0ff");
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.roundRect(xCenter - barWidth / 2, y, barWidth, Math.max(2, barHeight), 7);
    ctx.fill();

    points.push({ x: xCenter, y });
    ctx.fillStyle = "#64748b";
    ctx.textAlign = "center";
    ctx.fillText(days[index].label, xCenter, height - 23);

    ctx.fillStyle = "#172033";
    ctx.font = '600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillText(formatNumber(value), xCenter, Math.max(margin.top + 8, y - 10));
    ctx.font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  });

  if (points.length > 1) {
    ctx.strokeStyle = "#0f766e";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    points.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });
    ctx.stroke();

    ctx.fillStyle = "#0f766e";
    for (const point of points) {
      ctx.beginPath();
      ctx.arc(point.x, point.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const total = values.reduce((sum, value) => sum + value, 0);
  const peak = Math.max(...values, 0);
  const peakIndex = values.indexOf(peak);
  const scope = selectedId === "all"
    ? "全部样机"
    : state.breakers.find((item) => item.id === selectedId)?.name || "所选样机";
  summary.textContent = `${scope}近7日共新增 ${formatNumber(total)} 次，日均 ${formatNumber(Math.round(total / 7))} 次，峰值为 ${days[peakIndex]?.label || "-"} 的 ${formatNumber(peak)} 次。`;
}

function renderBreakers() {
  const keyword = $("#searchInput").value.trim().toLowerCase();
  const filtered = state.breakers.filter((item) => {
    const text = `${item.name} ${item.model} ${item.note}`.toLowerCase();
    return text.includes(keyword);
  });

  breakerList.replaceChildren();
  breakerList.classList.toggle("empty-state", filtered.length === 0);

  if (filtered.length === 0) {
    breakerList.textContent = state.breakers.length
      ? "未找到匹配样机。"
      : "暂无样机，请先新增一台断路器样机。";
    return;
  }

  for (const item of filtered) {
    const node = template.content.cloneNode(true);
    const card = node.querySelector(".breaker-card");
    card.dataset.id = item.id;
    node.querySelector("h3").textContent = item.name;
    node.querySelector(".meta").textContent =
      `${item.model || "未填写型号"} ｜ 创建：${formatDateTime(item.createdAt)} ｜ 更新：${formatDateTime(item.updatedAt)}`;
    node.querySelector(".note").textContent = item.note || "";
    node.querySelector(".count-value").textContent = formatNumber(item.count);

    const target = item.target || 0;
    const percent = target > 0 ? Math.min(100, Math.round((item.count / target) * 100)) : 0;
    node.querySelector(".progress-text").textContent = target > 0
      ? `目标：${formatNumber(target)} 次`
      : "未设置目标次数";
    node.querySelector(".progress-percent").textContent = target > 0 ? `${percent}%` : "-";
    node.querySelector(".progress-bar div").style.width = `${percent}%`;

    node.querySelector(".manual-btn").addEventListener("click", () => openManualDialog(item.id));
    node.querySelector(".edit-btn").addEventListener("click", () => openEditDialog(item.id));
    breakerList.appendChild(node);
  }
}

function renderLogs() {
  const logBody = $("#logBody");
  logBody.replaceChildren();

  if (!state.logs.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 8;
    td.className = "muted center";
    td.textContent = "暂无操作记录";
    tr.appendChild(td);
    logBody.appendChild(tr);
    return;
  }

  for (const log of state.logs) {
    const tr = document.createElement("tr");
    const data = [
      formatDateTime(log.time),
      log.breakerName,
      log.operatorName,
      `${log.delta > 0 ? "+" : ""}${formatNumber(log.delta)}`,
      formatNumber(log.totalAfter),
      log.reason || "",
      formatDateTime(log.updatedAt)
    ];

    data.forEach((value, index) => {
      const td = document.createElement("td");
      td.textContent = value;
      if (index === 3) td.className = log.delta >= 0 ? "positive" : "negative";
      tr.appendChild(td);
    });

    const actionTd = document.createElement("td");
    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.className = "secondary log-edit-btn";
    editButton.textContent = "修改时间";
    editButton.addEventListener("click", () => openEditLogDialog(log.id));
    actionTd.appendChild(editButton);
    tr.appendChild(actionTd);
    logBody.appendChild(tr);
  }
}

function render() {
  renderSummary();
  renderMachineSummary();
  renderTrendFilter();
  renderBreakers();
  renderLogs();
  renderTrendChart();
}

async function updateCount(id, delta, reason, operatorName, operationTime) {
  if (!requireConfiguredClient() || !state.session) return false;
  const breaker = state.breakers.find((item) => item.id === id);
  if (!breaker) return false;

  if (breaker.count + delta < 0) {
    alert("累计次数不能小于0。负数修正不得超过当前累计次数。");
    return false;
  }

  try {
    const { error } = await supabase.rpc("adjust_breaker_count", {
      p_breaker_id: id,
      p_delta: delta,
      p_reason: reason || "操作计数",
      p_operator_name: operatorName,
      p_operation_time: operationTime
    });
    if (error) throw error;
    saveDefaultOperator(operatorName);
    await loadData();
    return true;
  } catch (error) {
    console.error("更新次数失败：", error);
    showMessage(`更新次数失败：${friendlyError(error)}`, "error", 0);
    return false;
  }
}

function openManualDialog(id) {
  selectedBreakerId = id;
  const breaker = state.breakers.find((item) => item.id === id);
  if (!breaker) return;
  $("#manualTitle").textContent = `录入操作：${breaker.name}`;
  $("#manualDelta").value = "";
  $("#manualOperationTime").value = toDateTimeLocalValue(new Date());
  $("#manualOperator").value = getDefaultOperator();
  $("#manualReason").value = "";
  manualDialog.showModal();
}

function openEditDialog(id) {
  selectedBreakerId = id;
  const breaker = state.breakers.find((item) => item.id === id);
  if (!breaker) return;
  $("#editName").value = breaker.name;
  $("#editModel").value = breaker.model || "";
  $("#editTarget").value = breaker.target || "";
  $("#editNote").value = breaker.note || "";
  editDialog.showModal();
}

function openEditLogDialog(id) {
  selectedLogId = id;
  const log = state.logs.find((item) => item.id === id);
  if (!log) return;
  $("#editLogReadOnly").textContent =
    `${log.breakerName}｜变更 ${log.delta > 0 ? "+" : ""}${formatNumber(log.delta)} 次｜变更后累计 ${formatNumber(log.totalAfter)} 次。次数和累计值不可修改。`;
  $("#editLogTime").value = toDateTimeLocalValue(log.time);
  $("#editLogOperator").value = log.operatorName || getDefaultOperator();
  $("#editLogReason").value = log.reason || "";
  editLogDialog.showModal();
}

function download(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function exportJson() {
  const data = {
    exportedAt: new Date().toISOString(),
    app: "breaker-counter-online",
    version: 3,
    breakers: state.breakers,
    logs: state.logs
  };
  download(
    `breaker-counter-backup-${localDateKey()}.json`,
    JSON.stringify(data, null, 2),
    "application/json;charset=utf-8"
  );
}

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function exportCsv() {
  const rows = [
    ["操作时间", "样机编号", "操作人", "变更次数", "变更后累计", "说明", "最后修改时间"],
    ...state.logs.map((log) => [
      formatDateTime(log.time),
      log.breakerName,
      log.operatorName,
      log.delta,
      log.totalAfter,
      log.reason,
      formatDateTime(log.updatedAt)
    ])
  ];
  const csv = rows.map((row) => row.map(csvCell).join(",")).join("\n");
  download(
    `breaker-operation-log-${localDateKey()}.csv`,
    `\ufeff${csv}`,
    "text/csv;charset=utf-8"
  );
}

function normalizeTimestamp(value) {
  if (!value) return new Date().toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

async function importJson(file) {
  if (!supabase || !state.session) return;
  const reader = new FileReader();

  reader.onload = async () => {
    try {
      const data = JSON.parse(String(reader.result));
      if (!Array.isArray(data.breakers) || !Array.isArray(data.logs)) {
        throw new Error("备份文件格式不正确");
      }

      const ok = confirm(
        "导入后将删除云端现有样机和记录，并用备份内容覆盖。此操作会影响所有登录用户，是否继续？"
      );
      if (!ok) return;

      setConnectionStatus("正在导入云端数据……", "loading");

      const breakerIds = new Set();
      const breakers = data.breakers.map((item) => {
        let id = String(item.id || uid());
        while (breakerIds.has(id)) id = uid();
        breakerIds.add(id);
        return {
          id,
          name: String(item.name || "未命名样机").slice(0, 100),
          model: String(item.model || "").slice(0, 200),
          target: Math.max(0, toInt(item.target, 0)),
          count: Math.max(0, toInt(item.count, 0)),
          note: String(item.note || "").slice(0, 500),
          created_at: normalizeTimestamp(item.createdAt || item.created_at),
          updated_at: normalizeTimestamp(item.updatedAt || item.updated_at)
        };
      });

      const validIds = new Set(breakers.map((item) => item.id));
      const logs = data.logs
        .filter((item) => validIds.has(String(item.breakerId || item.breaker_id)))
        .slice(0, 3000)
        .map((item) => ({
          id: String(item.id || uid()),
          breaker_id: String(item.breakerId || item.breaker_id),
          breaker_name: String(item.breakerName || item.breaker_name || "未命名样机").slice(0, 100),
          operator_name: String(item.operatorName || item.operator_name || "历史导入").slice(0, 100),
          delta: toInt(item.delta, 0),
          total_after: Math.max(0, toInt(item.totalAfter ?? item.total_after, 0)),
          reason: String(item.reason || "").slice(0, 500),
          created_at: normalizeTimestamp(item.time || item.created_at),
          updated_at: normalizeTimestamp(item.updatedAt || item.updated_at || item.time || item.created_at)
        }));

      const clearResult = await supabase.from("breakers").delete().neq("id", "__never__");
      if (clearResult.error) throw clearResult.error;

      if (breakers.length) {
        const breakerInsert = await supabase.from("breakers").insert(breakers);
        if (breakerInsert.error) throw breakerInsert.error;
      }

      if (logs.length) {
        const logInsert = await supabase.from("operation_logs").insert(logs);
        if (logInsert.error) throw logInsert.error;
      }

      await loadData();
      showMessage("云端备份导入成功。", "success");
    } catch (error) {
      console.error("导入失败：", error);
      setConnectionStatus("导入失败", "error");
      showMessage(`导入失败：${friendlyError(error)}`, "error", 0);
    }
  };

  reader.onerror = () => showMessage("无法读取备份文件。", "error", 0);
  reader.readAsText(file, "utf-8");
}

async function showAuthenticated(session) {
  state.session = session;
  authMain.hidden = true;
  appMain.hidden = false;
  onlineActions.hidden = false;
  setConnectionStatus(`已登录：${session.user.email}`, "loading");
  $("#initialOperator").value = getDefaultOperator();
  startAutoRefresh();
  await loadData();
}

function showLoggedOut() {
  state.session = null;
  state.breakers = [];
  state.logs = [];
  stopAutoRefresh();
  authMain.hidden = false;
  appMain.hidden = true;
  onlineActions.hidden = true;
}

function startAutoRefresh() {
  stopAutoRefresh();
  refreshTimer = window.setInterval(() => loadData({ silent: true }), AUTO_REFRESH_MS);
}

function stopAutoRefresh() {
  if (refreshTimer) window.clearInterval(refreshTimer);
  refreshTimer = null;
}

function syncInitialOperatorRequirement() {
  const count = Math.max(0, toInt($("#initialCount").value, 0));
  const input = $("#initialOperator");
  input.required = count > 0;
  input.placeholder = count > 0 ? "初始次数大于0，必须填写操作人" : "初始次数大于0时填写";
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!requireConfiguredClient()) return;

  const email = $("#loginEmail").value.trim();
  const password = $("#loginPassword").value;
  setButtonBusy(loginButton, true, "登录中……", "登录");

  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    if (!data.session) throw new Error("未获取到登录会话");
    showMessage("登录成功。", "success");
  } catch (error) {
    console.error("登录失败：", error);
    showMessage(`登录失败：${friendlyError(error)}`, "error", 0);
  } finally {
    setButtonBusy(loginButton, false, "登录中……", "登录");
  }
});

breakerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!supabase || !state.session) return;

  const name = $("#breakerName").value.trim();
  if (!name) return;

  const addButton = $("#addBreakerBtn");
  const count = Math.max(0, toInt($("#initialCount").value, 0));
  const target = Math.max(0, toInt($("#targetCount").value, 0));
  const operatorName = $("#initialOperator").value.trim();
  if (count > 0 && !operatorName) {
    alert("初始次数大于0时，必须填写初始操作人。 ");
    return;
  }

  const nowIso = new Date().toISOString();
  const breaker = {
    id: uid(),
    name: name.slice(0, 100),
    model: $("#breakerModel").value.trim().slice(0, 200),
    target,
    count,
    note: $("#breakerNote").value.trim().slice(0, 500)
  };

  setButtonBusy(addButton, true, "正在写入云端……", "添加样机");

  try {
    const { error: breakerError } = await supabase.from("breakers").insert(breaker);
    if (breakerError) throw breakerError;

    if (count > 0) {
      const { error: logError } = await supabase.from("operation_logs").insert({
        id: uid(),
        breaker_id: breaker.id,
        breaker_name: breaker.name,
        operator_name: operatorName.slice(0, 100),
        delta: count,
        total_after: count,
        reason: "初始次数录入",
        created_at: nowIso,
        updated_at: nowIso
      });
      if (logError) throw logError;
      saveDefaultOperator(operatorName);
    }

    breakerForm.reset();
    $("#initialCount").value = 0;
    $("#initialOperator").value = getDefaultOperator();
    syncInitialOperatorRequirement();
    await loadData();
    showMessage("样机已保存到云端。", "success");
  } catch (error) {
    console.error("新增样机失败：", error);
    showMessage(`新增失败：${friendlyError(error)}`, "error", 0);
  } finally {
    setButtonBusy(addButton, false, "正在写入云端……", "添加样机");
  }
});

manualForm.addEventListener("submit", async (event) => {
  const submitter = event.submitter;
  if (submitter?.value === "cancel") return;
  event.preventDefault();

  const delta = toInt($("#manualDelta").value, Number.NaN);
  const operatorName = $("#manualOperator").value.trim();
  const operationTime = dateTimeLocalToIso($("#manualOperationTime").value);
  if (!Number.isFinite(delta) || delta === 0) {
    alert("请输入非0整数。正数表示增加，负数表示修正扣减。 ");
    return;
  }
  if (!operationTime) {
    alert("请输入有效的操作时间。 ");
    return;
  }
  if (!operatorName) {
    alert("请输入操作人。 ");
    return;
  }

  const button = $("#manualConfirmBtn");
  setButtonBusy(button, true, "提交中……", "确认录入");
  const success = await updateCount(
    selectedBreakerId,
    delta,
    $("#manualReason").value.trim().slice(0, 500) || "手动录入",
    operatorName.slice(0, 100),
    operationTime
  );
  setButtonBusy(button, false, "提交中……", "确认录入");
  if (success) {
    manualDialog.close();
    showMessage("操作记录已保存。", "success");
  }
});

editForm.addEventListener("submit", async (event) => {
  const submitter = event.submitter;
  if (submitter?.value === "cancel") return;
  event.preventDefault();

  const breaker = state.breakers.find((item) => item.id === selectedBreakerId);
  if (!breaker || !supabase || !state.session) return;

  const name = $("#editName").value.trim();
  if (!name) {
    alert("样机编号不能为空。 ");
    return;
  }

  const button = $("#editConfirmBtn");
  setButtonBusy(button, true, "保存中……", "保存");

  try {
    const { error } = await supabase
      .from("breakers")
      .update({
        name: name.slice(0, 100),
        model: $("#editModel").value.trim().slice(0, 200),
        target: Math.max(0, toInt($("#editTarget").value, 0)),
        note: $("#editNote").value.trim().slice(0, 500),
        updated_at: new Date().toISOString()
      })
      .eq("id", selectedBreakerId);

    if (error) throw error;
    editDialog.close();
    await loadData();
    showMessage("样机信息已更新。", "success");
  } catch (error) {
    console.error("编辑失败：", error);
    showMessage(`编辑失败：${friendlyError(error)}`, "error", 0);
  } finally {
    setButtonBusy(button, false, "保存中……", "保存");
  }
});

editLogForm.addEventListener("submit", async (event) => {
  const submitter = event.submitter;
  if (submitter?.value === "cancel") return;
  event.preventDefault();
  if (!supabase || !state.session) return;

  const log = state.logs.find((item) => item.id === selectedLogId);
  if (!log) return;

  const operationTime = dateTimeLocalToIso($("#editLogTime").value);
  const operatorName = $("#editLogOperator").value.trim();
  if (!operationTime) {
    alert("请输入有效的操作时间。 ");
    return;
  }
  if (!operatorName) {
    alert("请输入操作人。 ");
    return;
  }

  const button = $("#editLogConfirmBtn");
  setButtonBusy(button, true, "保存中……", "保存修改");

  try {
    const { error } = await supabase
      .from("operation_logs")
      .update({
        created_at: operationTime,
        operator_name: operatorName.slice(0, 100),
        reason: $("#editLogReason").value.trim().slice(0, 500),
        updated_at: new Date().toISOString()
      })
      .eq("id", selectedLogId);

    if (error) throw error;
    saveDefaultOperator(operatorName);
    editLogDialog.close();
    await loadData();
    showMessage("操作记录已修改。", "success");
  } catch (error) {
    console.error("修改操作记录失败：", error);
    showMessage(`修改失败：${friendlyError(error)}`, "error", 0);
  } finally {
    setButtonBusy(button, false, "保存中……", "保存修改");
  }
});

$("#initialCount").addEventListener("input", syncInitialOperatorRequirement);
$("#searchInput").addEventListener("input", renderBreakers);
$("#trendBreakerFilter").addEventListener("change", renderTrendChart);
$("#refreshBtn").addEventListener("click", () => loadData());
$("#exportJsonBtn").addEventListener("click", exportJson);
$("#exportCsvBtn").addEventListener("click", exportCsv);

$("#importFile").addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (file) importJson(file);
  event.target.value = "";
});

$("#clearLogBtn").addEventListener("click", async () => {
  if (!state.logs.length || !supabase || !state.session) return;
  const ok = confirm("确定清空所有云端操作记录吗？样机当前累计次数不会清零。建议先导出CSV。 ");
  if (!ok) return;

  try {
    setConnectionStatus("正在清空操作记录……", "loading");
    const { error } = await supabase.from("operation_logs").delete().neq("id", "__never__");
    if (error) throw error;
    await loadData();
    showMessage("操作记录已清空。", "success");
  } catch (error) {
    console.error("清空记录失败：", error);
    showMessage(`清空失败：${friendlyError(error)}`, "error", 0);
  }
});

$("#logoutBtn").addEventListener("click", async () => {
  if (!supabase) return;
  try {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
    showMessage("已退出登录。", "success");
  } catch (error) {
    showMessage(`退出失败：${friendlyError(error)}`, "error", 0);
  }
});

window.addEventListener("resize", () => {
  window.clearTimeout(chartResizeTimer);
  chartResizeTimer = window.setTimeout(renderTrendChart, 120);
});

async function initialize() {
  syncInitialOperatorRequirement();
  if (!requireConfiguredClient()) {
    loginButton.disabled = true;
    return;
  }

  const { data, error } = await supabase.auth.getSession();
  if (error) {
    showMessage(`读取登录状态失败：${friendlyError(error)}`, "error", 0);
    showLoggedOut();
    return;
  }

  if (data.session) await showAuthenticated(data.session);
  else showLoggedOut();

  supabase.auth.onAuthStateChange((_event, session) => {
    window.setTimeout(() => {
      if (session) showAuthenticated(session);
      else showLoggedOut();
    }, 0);
  });
}

initialize();
