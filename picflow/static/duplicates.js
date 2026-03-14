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

function formatSize(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(1)} ${units[index]}`;
}

function statusClass(label) {
  if (label === "duplicate") return "status-chip status-chip--duplicate";
  if (label === "distinct") return "status-chip status-chip--distinct";
  if (label === "blocked") return "status-chip status-chip--blocked";
  return "status-chip status-chip--pending";
}

const state = {
  filter: "needs-review",
  items: [],
  page: 1,
  pageSize: 50,
  counts: {},
  activeId: null,
};

function totalForFilter() {
  const counts = state.counts || {};
  if (state.filter === "duplicates") return counts.duplicate || 0;
  if (state.filter === "distinct") return counts.distinct || 0;
  if (state.filter === "blocked") return counts.blocked || 0;
  if (state.filter === "all") return counts.total || 0;
  return (counts.total || 0) - (counts.distinct || 0);
}

function pageCount() {
  const total = totalForFilter();
  return total > 0 ? Math.ceil(total / state.pageSize) : 1;
}

function currentOffset() {
  return (state.page - 1) * state.pageSize;
}

function renderSummary() {
  const counts = state.counts || {};
  document.getElementById("duplicatesSummary").innerHTML = [
    `<div><strong>Всего пар</strong><span>${counts.total || 0}</span></div>`,
    `<div><strong>Duplicate</strong><span>${counts.duplicate || 0}</span></div>`,
    `<div><strong>Blocked</strong><span>${counts.blocked || 0}</span></div>`,
    `<div><strong>Distinct</strong><span>${counts.distinct || 0}</span></div>`,
  ].join("");
}

function renderPager() {
  const total = totalForFilter();
  const totalPages = pageCount();
  const start = total === 0 ? 0 : currentOffset() + 1;
  const end = Math.min(total, currentOffset() + state.items.length);
  const text = total === 0
    ? "Страница 1 из 1 · 0 пар"
    : `Страница ${state.page} из ${totalPages} · пары ${start}-${end} из ${total}`;

  for (const id of ["pageIndicator", "pageIndicatorBottom"]) {
    document.getElementById(id).textContent = text;
  }
  for (const id of ["pagePrevBtn", "pagePrevBtnBottom"]) {
    document.getElementById(id).disabled = state.page <= 1;
  }
  for (const id of ["pageNextBtn", "pageNextBtnBottom"]) {
    document.getElementById(id).disabled = state.page >= totalPages;
  }
}

function renderLog(message) {
  document.getElementById("duplicatesLog").textContent = message;
}

function renderFeed() {
  const node = document.getElementById("pairFeed");
  if (!state.items.length) {
    node.innerHTML = '<div class="empty-state">На этой странице нет пар под выбранный фильтр.</div>';
    renderPager();
    return;
  }

  if (!state.activeId || !state.items.some((item) => item.id === state.activeId)) {
    state.activeId = state.items[0].id;
  }

  node.innerHTML = state.items
    .map((item) => {
      const isActive = item.id === state.activeId ? " active" : "";
      const aiReason = item.ai_reason || "AI еще не дал пояснение.";
      const manualLabel = item.manual_label || "нет";
      const rawResponse = item.ai_raw_response || "пусто";
      return `
        <article class="pair-card${isActive}" data-card-id="${item.id}">
          <div class="pair-header">
            <div class="pair-header__meta">
              <div class="badge-row">
                <span class="fact-pill">#${item.id}</span>
                <span class="${statusClass(item.effective_label)}">${escapeHtml(item.effective_label)}</span>
                <span class="fact-pill">score ${escapeHtml(item.candidate_score)}</span>
              </div>
              <div>Источники: <strong>${escapeHtml(item.left_root_name)}</strong> и <strong>${escapeHtml(item.right_root_name)}</strong></div>
            </div>
            <div class="pair-actions">
              <button class="primary" data-action-id="${item.id}" data-label="duplicate">Duplicate</button>
              <button data-action-id="${item.id}" data-label="distinct">Distinct</button>
              <button data-action-id="${item.id}" data-label="blocked">Blocked</button>
              <button data-action-id="${item.id}" data-label="clear">Clear</button>
            </div>
          </div>

          <div class="pair-compare">
            <article class="image-pane">
              <img src="${item.left_media_url}" alt="left">
              <div class="image-caption">
                <strong>${escapeHtml(item.left_file_name)}</strong>
                <div>${escapeHtml(item.left_root_name)} · ${item.left_width}x${item.left_height} · ${formatSize(item.left_size_bytes)}</div>
                <div>${escapeHtml(item.left_path)}</div>
              </div>
            </article>

            <article class="image-pane">
              <img src="${item.right_media_url}" alt="right">
              <div class="image-caption">
                <strong>${escapeHtml(item.right_file_name)}</strong>
                <div>${escapeHtml(item.right_root_name)} · ${item.right_width}x${item.right_height} · ${formatSize(item.right_size_bytes)}</div>
                <div>${escapeHtml(item.right_path)}</div>
              </div>
            </article>
          </div>

          <div class="pair-footer">
            <div class="metric-grid">
              ${[
                ["Exact hash", item.exact_hash_match],
                ["pHash", item.phash_distance],
                ["dHash", item.dhash_distance],
                ["aHash", item.ahash_distance],
                ["Center pHash", item.center_phash_distance],
                ["Center dHash", item.center_dhash_distance],
                ["Size ratio", item.size_ratio],
                ["AI confidence", item.ai_confidence ?? "—"],
              ]
                .map(
                  ([label, value]) => `
                    <div class="metric-card">
                      <div class="metric-card__label">${escapeHtml(label)}</div>
                      <div>${escapeHtml(value)}</div>
                    </div>
                  `,
                )
                .join("")}
            </div>

            <div class="pair-reason">
              <div><strong>Ручная метка:</strong> ${escapeHtml(manualLabel)}</div>
              <div><strong>Пояснение AI:</strong> ${escapeHtml(aiReason)}</div>
              <details class="details-box">
                <summary>Сырой ответ модели</summary>
                <pre class="log-box">${escapeHtml(rawResponse)}</pre>
              </details>
            </div>
          </div>
        </article>
      `;
    })
    .join("");

  node.querySelectorAll("[data-card-id]").forEach((card) => {
    card.addEventListener("click", (event) => {
      if (event.target.closest("[data-action-id]")) return;
      state.activeId = Number(card.dataset.cardId);
      renderFeed();
    });
  });

  node.querySelectorAll("[data-action-id]").forEach((button) => {
    button.addEventListener("click", async () => {
      await labelCandidate(Number(button.dataset.actionId), button.dataset.label);
    });
  });

  renderPager();
}

async function loadStats() {
  const payload = await api("/api/dashboard");
  state.counts = payload.stats.candidates || {};
  renderSummary();
}

async function loadPage() {
  const payload = await api(
    `/api/duplicates?filter=${encodeURIComponent(state.filter)}&limit=${state.pageSize}&offset=${currentOffset()}`,
  );
  state.items = payload.items;
  if (!state.items.length && state.page > 1) {
    state.page -= 1;
    return loadPage();
  }
  renderFeed();
}

async function labelCandidate(id, label) {
  await api(`/api/duplicates/${id}/label`, {
    method: "POST",
    body: JSON.stringify({ label }),
  });
  state.activeId = id;
  await loadStats();
  await loadPage();
}

async function runVerify(force) {
  await api("/api/verify", {
    method: "POST",
    body: JSON.stringify({ force }),
  });
  renderLog(
    force
      ? "AI-проверка всех пар запущена в фоне."
      : "AI-проверка только необработанных пар запущена в фоне.",
  );
}

async function showDeletePlan() {
  const payload = await api("/api/duplicates/apply-plan", { method: "POST", body: "{}" });
  renderLog(JSON.stringify(payload, null, 2));
}

async function applyDeletePlan() {
  const accepted = confirm("Применить удаление всех пар, которые помечены как duplicate?");
  if (!accepted) return;
  await api("/api/duplicates/apply", { method: "POST", body: "{}" });
  renderLog("Применение плана удаления запущено.");
}

async function refreshAll() {
  await loadStats();
  const totalPages = pageCount();
  if (state.page > totalPages) {
    state.page = totalPages;
  }
  await loadPage();
}

function changePage(delta) {
  const nextPage = state.page + delta;
  if (nextPage < 1 || nextPage > pageCount()) return;
  state.page = nextPage;
  loadPage();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

document.getElementById("filterSelect").addEventListener("change", async (event) => {
  state.filter = event.target.value;
  state.page = 1;
  await refreshAll();
});

for (const id of ["pagePrevBtn", "pagePrevBtnBottom"]) {
  document.getElementById(id).addEventListener("click", () => changePage(-1));
}
for (const id of ["pageNextBtn", "pageNextBtnBottom"]) {
  document.getElementById(id).addEventListener("click", () => changePage(1));
}

document.getElementById("verifyPendingBtn").addEventListener("click", () => runVerify(false));
document.getElementById("verifyForceBtn").addEventListener("click", () => runVerify(true));
document.getElementById("showDeletePlanBtn").addEventListener("click", showDeletePlan);
document.getElementById("applyDeletePlanBtn").addEventListener("click", applyDeletePlan);

window.addEventListener("keydown", async (event) => {
  if (event.target.matches("input, textarea, select")) return;
  if (!state.activeId) return;
  if (event.key.toLowerCase() === "d") await labelCandidate(state.activeId, "duplicate");
  if (event.key.toLowerCase() === "n") await labelCandidate(state.activeId, "distinct");
  if (event.key.toLowerCase() === "b") await labelCandidate(state.activeId, "blocked");
  if (event.key.toLowerCase() === "c") await labelCandidate(state.activeId, "clear");
});

refreshAll();
