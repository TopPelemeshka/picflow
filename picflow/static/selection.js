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

const state = {
  filter: "all",
  items: [],
  activeIndex: 0,
  windowRadius: 24,
};

function currentItem() {
  return state.items[state.activeIndex];
}

function renderSummary(stats) {
  const selection = stats.selection || {};
  document.getElementById("selectionSummary").innerHTML = [
    `<div><strong>Всего входящих</strong><span>${selection.total || 0}</span></div>`,
    `<div><strong>Good</strong><span>${selection.good || 0}</span></div>`,
    `<div><strong>Bad</strong><span>${selection.bad || 0}</span></div>`,
    `<div><strong>Без метки</strong><span>${selection.pending || 0}</span></div>`,
  ].join("");
}

function renderQueue() {
  const node = document.getElementById("selectionList");
  if (!state.items.length) {
    node.innerHTML = '<div class="empty-state">Во входящих папках нет картинок под этот фильтр.</div>';
    document.getElementById("selectionCounter").textContent = "0 / 0";
    return;
  }

  document.getElementById("selectionCounter").textContent = `${state.activeIndex + 1} / ${state.items.length}`;
  const start = Math.max(0, state.activeIndex - state.windowRadius);
  const end = Math.min(state.items.length, state.activeIndex + state.windowRadius + 1);
  node.innerHTML = state.items
    .slice(start, end)
    .map((item, offset) => {
      const index = start + offset;
      const active = index === state.activeIndex ? " active" : "";
      return `
        <article class="queue-item${active}" data-index="${index}">
          <strong>${escapeHtml(item.file_name)}</strong>
          <div>${escapeHtml(item.root_name)}</div>
          <span class="queue-item__tag">${escapeHtml(item.effective_label)}</span>
        </article>
      `;
    })
    .join("");

  node.querySelectorAll("[data-index]").forEach((item) => {
    item.addEventListener("click", () => {
      state.activeIndex = Number(item.dataset.index);
      renderCurrent();
    });
  });
}

function renderCurrent() {
  renderQueue();
  const item = currentItem();
  if (!item) {
    document.getElementById("selectionTitle").textContent = "Нет фото";
    document.getElementById("selectionImage").removeAttribute("src");
    document.getElementById("selectionMeta").textContent = "";
    return;
  }

  document.getElementById("selectionTitle").textContent = `${item.file_name} · ${item.effective_label}`;
  document.getElementById("selectionImage").src = item.media_url;
  document.getElementById("selectionMeta").innerHTML = `
    <strong>${escapeHtml(item.file_name)}</strong><br>
    ${escapeHtml(item.root_name)} · ${item.width}x${item.height} · ${formatSize(item.size_bytes)}<br>
    ${escapeHtml(item.path)}
  `;
}

async function loadStats() {
  const payload = await api("/api/dashboard");
  renderSummary(payload.stats);
}

async function loadList(reset = false) {
  const payload = await api(`/api/selection?filter=${encodeURIComponent(state.filter)}&limit=5000&offset=0`);
  state.items = payload.items;
  if (reset) {
    state.activeIndex = 0;
  }
  if (state.activeIndex >= state.items.length) {
    state.activeIndex = Math.max(0, state.items.length - 1);
  }
  renderCurrent();
}

async function labelCurrent(label) {
  const item = currentItem();
  if (!item) return;
  await api(`/api/selection/${item.id}/label`, {
    method: "POST",
    body: JSON.stringify({ label }),
  });
  item.selection_label = label === "clear" ? null : label;
  item.effective_label = item.selection_label || "pending";
  renderCurrent();
  await loadStats();
}

function move(delta) {
  if (!state.items.length) return;
  state.activeIndex = Math.max(0, Math.min(state.items.length - 1, state.activeIndex + delta));
  renderCurrent();
}

async function showPlan() {
  const item = currentItem();
  if (!item) return;
  const payload = await api("/api/selection/apply-plan", {
    method: "POST",
    body: JSON.stringify({ through_image_id: item.id }),
  });
  document.getElementById("selectionPlanBox").textContent = JSON.stringify(payload, null, 2);
}

async function applySelection() {
  const item = currentItem();
  if (!item) return;
  const accepted = confirm("Разнести просмотренный блок от начала очереди до текущей карточки?");
  if (!accepted) return;
  await api("/api/selection/apply", {
    method: "POST",
    body: JSON.stringify({ through_image_id: item.id }),
  });
  document.getElementById("selectionPlanBox").textContent =
    "Задача разнесения просмотренного блока запущена.";
}

document.getElementById("selectionFilter").addEventListener("change", async (event) => {
  state.filter = event.target.value;
  await loadList(true);
});

document.querySelectorAll("[data-selection-label]").forEach((button) => {
  button.addEventListener("click", async () => {
    await labelCurrent(button.dataset.selectionLabel);
  });
});

document.getElementById("selectionPrevBtn").addEventListener("click", () => move(-1));
document.getElementById("selectionNextBtn").addEventListener("click", () => move(1));
document.getElementById("selectionPlanBtn").addEventListener("click", showPlan);
document.getElementById("selectionApplyBtn").addEventListener("click", applySelection);

window.addEventListener("keydown", async (event) => {
  if (event.target.matches("input, textarea, select")) return;
  if (event.key === "ArrowLeft") move(-1);
  if (event.key === "ArrowRight") move(1);
  if (event.key.toLowerCase() === "g") await labelCurrent("good");
  if (event.key.toLowerCase() === "b") await labelCurrent("bad");
  if (event.key.toLowerCase() === "c") await labelCurrent("clear");
});

loadStats();
loadList(true);
