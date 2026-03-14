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
  const roles = stats.images_by_role;
  const cards = [
    statCard("Всего фото", stats.images_total),
    statCard("В эталоне", roles.reference || 0),
    statCard("Новые входящие", roles.incoming || 0),
    statCard("Одобренные без категории", roles.approved || 0),
    statCard("Неинтересные", roles.rejected || 0),
    statCard("Кандидаты в дубли", stats.candidates.total || 0),
    statCard("AI/ручные дубли", stats.candidates.duplicate || 0),
    statCard("Блокировки", stats.candidates.blocked || 0),
  ];
  document.getElementById("statsGrid").innerHTML = cards.join("");
}

function renderJobs(jobs) {
  const node = document.getElementById("jobsBox");
  if (!jobs.length) {
    node.innerHTML = "<p>Задач пока нет.</p>";
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
  renderJobs(payload.jobs);
}

async function start(path, body = {}) {
  try {
    const result = await api(path, { method: "POST", body: JSON.stringify(body) });
    await refresh();
    return result;
  } catch (error) {
    alert(error.message);
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

document.getElementById("scanBtn").addEventListener("click", () => start("/api/scan", {}));
document.getElementById("candidateBtn").addEventListener("click", () => start("/api/candidates", {}));
document.getElementById("verifyBtn").addEventListener("click", () => start("/api/verify", {}));
document.getElementById("applyBtn").addEventListener("click", async () => {
  const accepted = confirm("Подтвердить применение плана удаления дублей?");
  if (!accepted) return;
  await start("/api/duplicates/apply", {});
});
document.getElementById("planBtn").addEventListener("click", showPlan);
document.getElementById("refreshBtn").addEventListener("click", refresh);

refresh();
setInterval(refresh, 5000);
