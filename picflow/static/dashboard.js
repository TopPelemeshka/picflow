async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(payload.error || response.statusText);
  }
  return response.json();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function statusCard(title, value, detail = "") {
  return `
    <article class="status-card">
      <div>${escapeHtml(title)}</div>
      <div class="status-card__value">${escapeHtml(value)}</div>
      <div class="status-card__detail">${escapeHtml(detail)}</div>
    </article>
  `;
}

function renderStats(payload) {
  const stats = payload.stats;
  const roles = stats.images_by_role || {};
  const selection = stats.selection || {};
  const category = stats.category || {};
  const categoryReady = (category.total || 0) - (category.pending || 0);
  const liked = selection.good || 0;
  const unliked = Math.max(0, (selection.total || 0) - liked);
  const cards = [
    statusCard("Всего фото", stats.images_total || 0, "Все активные файлы в индексе"),
    statusCard("Эталон", roles.reference || 0, "Содержимое all_photos"),
    statusCard("Входящие", roles.incoming || 0, "Еще не разобранные папки"),
    statusCard("Дубли", stats.candidates.duplicate || 0, "Уже помечены как duplicate"),
    statusCard("На проверке", (stats.candidates.total || 0) - (stats.candidates.distinct || 0), "Pending, duplicate и blocked"),
    statusCard("Нравится", liked, "Будет отправлено в approved_unsorted"),
    statusCard("Без отметки", unliked, "Автоматически уйдет в rejected_pool"),
    statusCard("Категории готовы", categoryReady || 0, "Размеченные approved фото"),
  ];
  document.getElementById("statsGrid").innerHTML = cards.join("");
}

function renderConfig(config) {
  const rows = [
    ["Конфиг", config.config_path],
    ["Библиотека", config.library_root],
    ["Эталон", config.reference_dir],
    ["Approved", config.approved_dir],
    ["Rejected", config.rejected_dir],
    ["Export", config.export_dir],
    ["Модель", config.model],
    ["Прокси", config.proxy_url || "не задан"],
  ];

  document.getElementById("configStrip").innerHTML = rows
    .slice(0, 4)
    .map(([label, value]) => `<span class="fact-pill"><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</span>`)
    .join("");

  document.getElementById("configBox").innerHTML = rows
    .map(
      ([label, value]) => `
        <article class="config-item">
          <div class="config-item__label">${escapeHtml(label)}</div>
          <div class="config-item__value">${escapeHtml(value)}</div>
        </article>
      `,
    )
    .join("");
}

function renderJobs(jobs) {
  const node = document.getElementById("jobsBox");
  if (!jobs.length) {
    node.innerHTML = '<div class="empty-state">Фоновых задач сейчас нет.</div>';
    return;
  }

  node.innerHTML = jobs
    .map(
      (job) => `
        <article class="job-item">
          <strong>#${escapeHtml(job.id)} ${escapeHtml(job.kind)}</strong>
          <div>Статус: ${escapeHtml(job.status)}</div>
          <div>Прогресс: ${Math.round((job.progress || 0) * 100)}%</div>
          <div>${escapeHtml(job.message || "")}</div>
          ${
            job.result && Object.keys(job.result).length
              ? `<pre class="log-box">${escapeHtml(JSON.stringify(job.result, null, 2))}</pre>`
              : ""
          }
        </article>
      `,
    )
    .join("");
}

async function refresh() {
  const payload = await api("/api/dashboard");
  renderStats(payload);
  renderConfig(payload.config);
  renderJobs(payload.jobs);
}

async function start(path, body = {}) {
  try {
    const result = await api(path, { method: "POST", body: JSON.stringify(body) });
    await refresh();
    return result;
  } catch (error) {
    alert(error.message);
    throw error;
  }
}

async function showPlan() {
  try {
    const payload = await api("/api/duplicates/apply-plan", { method: "POST", body: "{}" });
    document.getElementById("planBox").textContent = JSON.stringify(payload, null, 2);
  } catch (error) {
    alert(error.message);
  }
}

document.getElementById("scanBtn").addEventListener("click", () => start("/api/scan", { create_runtime_dirs: true }));
document.getElementById("candidateBtn").addEventListener("click", () => start("/api/candidates", {}));
document.getElementById("verifyBtn").addEventListener("click", () => start("/api/verify", { force: false }));
document.getElementById("verifyForceBtn").addEventListener("click", () => start("/api/verify", { force: true }));
document.getElementById("applyBtn").addEventListener("click", async () => {
  const accepted = confirm("Применить план удаления дублей?");
  if (!accepted) return;
  await start("/api/duplicates/apply", {});
});
document.getElementById("planBtn").addEventListener("click", showPlan);
document.getElementById("refreshBtn").addEventListener("click", refresh);

refresh();
setInterval(refresh, 5000);
