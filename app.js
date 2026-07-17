import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

/*
 * 只需修改下面两项：
 * 1. Supabase 项目的 Project URL
 * 2. Supabase 的 Publishable key（旧项目中可能显示为 anon key）
 *
 * 不要把 sb_secret_... 或 service_role key 放进网页代码。
 */
const SUPABASE_URL = "https://bsisdwurajedsiwqtrvz.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_N1Q4bYnrH7LcHlPTKWcy5g_35ihhwbs";
const AUTO_REFRESH_MS = 20_000;

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
let refreshTimer = null;
let messageTimer = null;

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
    breakerId: row.breaker_id,
    breakerName: row.breaker_name,
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
        .select("id,breaker_id,breaker_name,delta,total_after,reason,created_at")
        .order("created_at", { ascending: false })
        .limit(1000)
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

  if (/Invalid API key|No API key/i.test(message)) {
    return "Supabase Publishable key 不正确。";
  }
  if (/relation .* does not exist/i.test(message)) {
    return "数据库表尚未创建，请先执行 supabase-setup.sql。";
  }
  if (/row-level security|permission denied|not allowed/i.test(message)) {
    return "数据库权限不足，请检查 RLS 策略和当前登录账号。";
  }
  if (/Failed to fetch|NetworkError|fetch/i.test(message)) {
    return "网络连接失败，请检查网络、Project URL 和浏览器控制台。";
  }
  return message;
}

function renderSummary() {
  const totalBreakers = state.breakers.length;
  const totalOperations = state.breakers.reduce((sum, item) => sum + item.count, 0);
  const today = localDateKey();
  const todayOperations = state.logs
    .filter((log) => localDateKey(log.time) === today && log.delta > 0)
    .reduce((sum, log) => sum + log.delta, 0);
  const finishedBreakers = state.breakers.filter(
    (item) => item.target > 0 && item.count >= item.target
  ).length;

  $("#totalBreakers").textContent = formatNumber(totalBreakers);
  $("#totalOperations").textContent = formatNumber(totalOperations);
  $("#todayOperations").textContent = formatNumber(todayOperations);
  $("#finishedBreakers").textContent = formatNumber(finishedBreakers);
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

    node.querySelectorAll("[data-delta]").forEach((button) => {
      button.addEventListener("click", () =>
        updateCount(item.id, toInt(button.dataset.delta), `快捷增加 ${button.dataset.delta} 次`, button)
      );
    });
    node.querySelector(".manual-btn").addEventListener("click", () => openManualDialog(item.id));
    node.querySelector(".edit-btn").addEventListener("click", () => openEditDialog(item.id));
    node.querySelector(".delete-btn").addEventListener("click", () => deleteBreaker(item.id));

    breakerList.appendChild(node);
  }
}

function renderLogs() {
  const logBody = $("#logBody");
  logBody.replaceChildren();

  if (!state.logs.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 5;
    td.className = "muted center";
    td.textContent = "暂无操作记录";
    tr.appendChild(td);
    logBody.appendChild(tr);
    return;
  }

  for (const log of state.logs) {
    const tr = document.createElement("tr");
    const values = [
      formatDateTime(log.time),
      log.breakerName,
      `${log.delta > 0 ? "+" : ""}${formatNumber(log.delta)}`,
      formatNumber(log.totalAfter),
      log.reason || ""
    ];

    for (const value of values) {
      const td = document.createElement("td");
      td.textContent = value;
      tr.appendChild(td);
    }
    logBody.appendChild(tr);
  }
}

function render() {
  renderSummary();
  renderBreakers();
  renderLogs();
}

async function updateCount(id, delta, reason, button = null) {
  if (!requireConfiguredClient() || !state.session) return;
  const breaker = state.breakers.find((item) => item.id === id);
  if (!breaker) return;

  if (breaker.count + delta < 0) {
    alert("累计次数不能小于 0。若需清零，请输入不超过当前累计次数的负数。 ");
    return;
  }

  const originalText = button?.textContent || "";
  if (button) setButtonBusy(button, true, "提交中…", originalText);

  try {
    const { error } = await supabase.rpc("adjust_breaker_count", {
      p_breaker_id: id,
      p_delta: delta,
      p_reason: reason || "操作计数"
    });
    if (error) throw error;
    await loadData();
  } catch (error) {
    console.error("更新次数失败：", error);
    showMessage(`更新次数失败：${friendlyError(error)}`, "error", 0);
  } finally {
    if (button) setButtonBusy(button, false, "提交中…", originalText);
  }
}

function openManualDialog(id) {
  selectedBreakerId = id;
  const breaker = state.breakers.find((item) => item.id === id);
  if (!breaker) return;
  $("#manualTitle").textContent = `手动录入：${breaker.name}`;
  $("#manualDelta").value = "";
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

async function deleteBreaker(id) {
  if (!supabase || !state.session) return;
  const breaker = state.breakers.find((item) => item.id === id);
  if (!breaker) return;

  const ok = confirm(`确定删除样机「${breaker.name}」吗？相关操作记录也会同时删除。`);
  if (!ok) return;

  try {
    setConnectionStatus("正在删除云端数据……", "loading");
    const { error } = await supabase.from("breakers").delete().eq("id", id);
    if (error) throw error;
    await loadData();
    showMessage("样机已删除。", "success");
  } catch (error) {
    console.error("删除样机失败：", error);
    showMessage(`删除失败：${friendlyError(error)}`, "error", 0);
  }
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
    version: 2,
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
    ["时间", "样机编号", "变更次数", "变更后累计", "说明"],
    ...state.logs.map((log) => [
      formatDateTime(log.time),
      log.breakerName,
      log.delta,
      log.totalAfter,
      log.reason
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
        .slice(0, 1000)
        .map((item) => ({
          id: String(item.id || uid()),
          breaker_id: String(item.breakerId || item.breaker_id),
          breaker_name: String(item.breakerName || item.breaker_name || "未命名样机").slice(0, 100),
          delta: toInt(item.delta, 0),
          total_after: Math.max(0, toInt(item.totalAfter ?? item.total_after, 0)),
          reason: String(item.reason || "").slice(0, 500),
          created_at: normalizeTimestamp(item.time || item.created_at)
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
        delta: count,
        total_after: count,
        reason: "初始次数录入"
      });
      if (logError) throw logError;
    }

    breakerForm.reset();
    $("#initialCount").value = 0;
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
  if (!Number.isFinite(delta) || delta === 0) {
    alert("请输入非 0 的整数。正数表示增加，负数表示修正扣减。 ");
    return;
  }

  const button = $("#manualConfirmBtn");
  setButtonBusy(button, true, "提交中……", "确认");
  await updateCount(
    selectedBreakerId,
    delta,
    $("#manualReason").value.trim().slice(0, 500) || "手动录入"
  );
  setButtonBusy(button, false, "提交中……", "确认");
  manualDialog.close();
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

$("#searchInput").addEventListener("input", renderBreakers);
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
  const ok = confirm("确定清空所有云端操作记录吗？样机当前累计次数不会清零。建议先导出 CSV。 ");
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

async function initialize() {
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
