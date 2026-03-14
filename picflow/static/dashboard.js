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

function statCard(title, value, detail = "") {
  return `
    <article class="stat-card">
      <div>${title}</div>
      <span class="value">${value}</span>
      <div>${detail}</div>
    </article>
  `;
}

function renderStats(payload) {
  const stats = payload.stats;
  const roles = stats.images_by_role || {};
  const selection = stats.selection || {};
  const category = stats.category || {};
  const categoryReady = (category.total || 0) - (category.pending || 0);
  const cards = [
    statCard("Всего фото", stats.images_total || 0),
    statCard("Эталон", roles.reference || 0),
    statCard("Входящие", roles.incoming || 0),
    statCard("Approved", roles.approved || 0),
    statCard("Rejected", roles.rejected || 0),
    statCard("Кандидаты в дубли", stats.candidates.total || 0),
    statCard("Помечены как дубли", stats.candidates.duplicate || 0),
    statCard("Good", selection.good || 0),
    statCard("Bad", selection.bad || 0),
    statCard("Без оценки", selection.pending || 0),
    statCard("Категории готовы", categoryReady || 0),
    statCard("Ждут категории", category.pending || 0),
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
    .map(([label, value]) => `<span class="pill"><strong>${label}:</strong> ${value}</span>`)
    .join("");
  document.getElementById("configBox").innerHTML = rows
    .map(([label, value]) => `<div class="config-row"><strong>${label}</strong><span>${value}</span></div>`)
    .join("");
}

function renderJobs(jobs) {
  const node = document.getElementById("jobsBox");
  if (!jobs.length) {
    node.innerHTML = "<p>Фоновых задач пока нет.</p>";
    return;
  }
  node.innerHTML = jobs
    .map(
      (job) => `
        <article class="job-item">
          <strong>#${job.id} ${job.kind}</strong>
          <div>Статус: ${job.status}</div>
          <div>Прогресс: ${Math.round((job.progress || 0) * 100)}%</div>
          <div>${job.message || ""}</div>
          ${
            job.result && Object.keys(job.result).length
              ? `<pre class="log-box">${JSON.stringify(job.result, null, 2)}</pre>`
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
  const accepted = confirm("Подтвердить применение плана удаления дублей?");
  if (!accepted) return;
  await start("/api/duplicates/apply", {});
});
document.getElementById("planBtn").addEventListener("click", showPlan);
document.getElementById("refreshBtn").addEventListener("click", refresh);

refresh();
setInterval(refresh, 5000);
