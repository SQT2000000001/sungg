const STORAGE_KEY = "breakerCounterApp.v1";

const state = loadState();
let selectedBreakerId = null;

const $ = (selector) => document.querySelector(selector);
const breakerForm = $("#breakerForm");
const breakerList = $("#breakerList");
const template = $("#breakerCardTemplate");
const manualDialog = $("#manualDialog");
const manualForm = $("#manualForm");
const editDialog = $("#editDialog");
const editForm = $("#editForm");

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { breakers: [], logs: [] };
    const parsed = JSON.parse(raw);
    return {
      breakers: Array.isArray(parsed.breakers) ? parsed.breakers : [],
      logs: Array.isArray(parsed.logs) ? parsed.logs : []
    };
  } catch (error) {
    console.error(error);
    return { breakers: [], logs: [] };
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  render();
}

function uid() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function nowString() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function todayKey() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function toInt(value, fallback = 0) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(value || 0);
}

function addLog(breaker, delta, reason) {
  state.logs.unshift({
    id: uid(),
    time: nowString(),
    breakerId: breaker.id,
    breakerName: breaker.name,
    delta,
    totalAfter: breaker.count,
    reason: reason || "操作计数"
  });
  state.logs = state.logs.slice(0, 1000);
}

function updateCount(id, delta, reason) {
  const breaker = state.breakers.find((item) => item.id === id);
  if (!breaker) return;
  const next = breaker.count + delta;
  if (next < 0) {
    alert("累计次数不能小于 0。若需清零，请用负数修正到当前累计次数以内。");
    return;
  }
  breaker.count = next;
  breaker.updatedAt = nowString();
  addLog(breaker, delta, reason);
  saveState();
}

function renderSummary() {
  const totalBreakers = state.breakers.length;
  const totalOperations = state.breakers.reduce((sum, item) => sum + item.count, 0);
  const today = todayKey();
  const todayOperations = state.logs
    .filter((log) => log.time.startsWith(today) && log.delta > 0)
    .reduce((sum, log) => sum + log.delta, 0);
  const finishedBreakers = state.breakers.filter((item) => item.target > 0 && item.count >= item.target).length;

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

  breakerList.innerHTML = "";
  breakerList.classList.toggle("empty-state", filtered.length === 0);
  if (filtered.length === 0) {
    breakerList.textContent = state.breakers.length ? "未找到匹配样机。" : "暂无样机，请先新增一台断路器样机。";
    return;
  }

  for (const item of filtered) {
    const node = template.content.cloneNode(true);
    const card = node.querySelector(".breaker-card");
    card.dataset.id = item.id;
    node.querySelector("h3").textContent = item.name;
    node.querySelector(".meta").textContent = `${item.model || "未填写型号"} ｜ 创建：${item.createdAt || "-"} ｜ 更新：${item.updatedAt || "-"}`;
    node.querySelector(".note").textContent = item.note || "";
    node.querySelector(".count-value").textContent = formatNumber(item.count);

    const target = item.target || 0;
    const percent = target > 0 ? Math.min(100, Math.round((item.count / target) * 100)) : 0;
    node.querySelector(".progress-text").textContent = target > 0
      ? `目标：${formatNumber(target)} 次`
      : "未设置目标次数";
    node.querySelector(".progress-percent").textContent = target > 0 ? `${percent}%` : "-";
    node.querySelector(".progress-bar div").style.width = `${percent}%`;

    node.querySelectorAll("[data-delta]").forEach((btn) => {
      btn.addEventListener("click", () => updateCount(item.id, toInt(btn.dataset.delta), `快捷增加 ${btn.dataset.delta} 次`));
    });
    node.querySelector(".manual-btn").addEventListener("click", () => openManualDialog(item.id));
    node.querySelector(".edit-btn").addEventListener("click", () => openEditDialog(item.id));
    node.querySelector(".delete-btn").addEventListener("click", () => deleteBreaker(item.id));

    breakerList.appendChild(node);
  }
}

function renderLogs() {
  const logBody = $("#logBody");
  logBody.innerHTML = "";
  if (!state.logs.length) {
    logBody.innerHTML = '<tr><td colspan="5" class="muted center">暂无操作记录</td></tr>';
    return;
  }
  for (const log of state.logs) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(log.time)}</td>
      <td>${escapeHtml(log.breakerName)}</td>
      <td>${log.delta > 0 ? "+" : ""}${formatNumber(log.delta)}</td>
      <td>${formatNumber(log.totalAfter)}</td>
      <td>${escapeHtml(log.reason || "")}</td>
    `;
    logBody.appendChild(tr);
  }
}

function render() {
  renderSummary();
  renderBreakers();
  renderLogs();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function openManualDialog(id) {
  selectedBreakerId = id;
  const breaker = state.breakers.find((item) => item.id === id);
  $("#manualTitle").textContent = `手动录入：${breaker.name}`;
  $("#manualDelta").value = "";
  $("#manualReason").value = "";
  manualDialog.showModal();
}

function openEditDialog(id) {
  selectedBreakerId = id;
  const breaker = state.breakers.find((item) => item.id === id);
  $("#editName").value = breaker.name;
  $("#editModel").value = breaker.model || "";
  $("#editTarget").value = breaker.target || "";
  $("#editNote").value = breaker.note || "";
  editDialog.showModal();
}

function deleteBreaker(id) {
  const breaker = state.breakers.find((item) => item.id === id);
  if (!breaker) return;
  const ok = confirm(`确定删除样机「${breaker.name}」吗？该操作会同时删除该样机的相关记录。`);
  if (!ok) return;
  state.breakers = state.breakers.filter((item) => item.id !== id);
  state.logs = state.logs.filter((log) => log.breakerId !== id);
  saveState();
}

function download(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function exportJson() {
  const data = {
    exportedAt: nowString(),
    app: "breaker-counter",
    version: 1,
    ...state
  };
  download(`breaker-counter-backup-${todayKey()}.json`, JSON.stringify(data, null, 2), "application/json;charset=utf-8");
}

function exportCsv() {
  const rows = [
    ["时间", "样机编号", "变更次数", "变更后累计", "说明"],
    ...state.logs.map((log) => [log.time, log.breakerName, log.delta, log.totalAfter, log.reason])
  ];
  const csv = rows.map((row) => row.map(csvCell).join(",")).join("\n");
  download(`breaker-operation-log-${todayKey()}.csv`, "\ufeff" + csv, "text/csv;charset=utf-8");
}

function csvCell(value) {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

function importJson(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!Array.isArray(data.breakers) || !Array.isArray(data.logs)) {
        throw new Error("备份文件格式不正确");
      }
      const ok = confirm("导入后将覆盖当前浏览器中的数据，是否继续？");
      if (!ok) return;
      state.breakers = data.breakers;
      state.logs = data.logs;
      saveState();
      alert("导入成功。");
    } catch (error) {
      alert(`导入失败：${error.message}`);
    }
  };
  reader.readAsText(file, "utf-8");
}

breakerForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = $("#breakerName").value.trim();
  if (!name) return;
  const count = Math.max(0, toInt($("#initialCount").value, 0));
  const target = Math.max(0, toInt($("#targetCount").value, 0));
  const breaker = {
    id: uid(),
    name,
    model: $("#breakerModel").value.trim(),
    target,
    count,
    note: $("#breakerNote").value.trim(),
    createdAt: nowString(),
    updatedAt: nowString()
  };
  state.breakers.unshift(breaker);
  if (count > 0) addLog(breaker, count, "初始次数录入");
  breakerForm.reset();
  $("#initialCount").value = 0;
  saveState();
});

manualForm.addEventListener("submit", (event) => {
  const submitter = event.submitter;
  if (submitter && submitter.value === "cancel") return;
  event.preventDefault();
  const delta = toInt($("#manualDelta").value, NaN);
  if (!Number.isFinite(delta) || delta === 0) {
    alert("请输入非 0 的整数。正数表示增加，负数表示修正扣减。");
    return;
  }
  updateCount(selectedBreakerId, delta, $("#manualReason").value.trim() || "手动录入");
  manualDialog.close();
});

editForm.addEventListener("submit", (event) => {
  const submitter = event.submitter;
  if (submitter && submitter.value === "cancel") return;
  event.preventDefault();
  const breaker = state.breakers.find((item) => item.id === selectedBreakerId);
  if (!breaker) return;
  breaker.name = $("#editName").value.trim();
  breaker.model = $("#editModel").value.trim();
  breaker.target = Math.max(0, toInt($("#editTarget").value, 0));
  breaker.note = $("#editNote").value.trim();
  breaker.updatedAt = nowString();
  saveState();
  editDialog.close();
});

$("#searchInput").addEventListener("input", renderBreakers);
$("#exportJsonBtn").addEventListener("click", exportJson);
$("#exportCsvBtn").addEventListener("click", exportCsv);
$("#importFile").addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (file) importJson(file);
  event.target.value = "";
});
$("#clearLogBtn").addEventListener("click", () => {
  if (!state.logs.length) return;
  const ok = confirm("确定清空所有操作记录吗？样机当前累计次数不会被清零。建议先导出 CSV。");
  if (!ok) return;
  state.logs = [];
  saveState();
});

render();
