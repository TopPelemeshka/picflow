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

const state = {
  categories: [],
  filter: "all",
  items: [],
  activeIndex: 0,
  windowRadius: 25,
};

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

function currentItem() {
  return state.items[state.activeIndex];
}

function renderSummary(stats) {
  const category = stats.category || {};
  const ready = (category.total || 0) - (category.pending || 0);
  document.getElementById("categorySummary").innerHTML = [
    `<div><strong>Всего approved:</strong> ${category.total || 0}</div>`,
    `<div><strong>Размечено:</strong> ${ready || 0}</div>`,
    `<div><strong>Без категории:</strong> ${category.pending || 0}</div>`,
    `<div><strong>Blocked:</strong> ${category.blocked || 0}</div>`,
  ].join("");
}

function renderButtons() {
  const node = document.getElementById("categoryButtons");
  node.innerHTML = [
    ...state.categories.map((category, index) => `<button data-category="${category}">${index + 1}: ${category}</button>`),
    '<button data-category="blocked">B: blocked</button>',
    '<button data-category="clear">C: clear</button>',
  ].join("");
  node.querySelectorAll("[data-category]").forEach((button) => {
    button.addEventListener("click", async () => {
      await labelCurrent(button.dataset.category);
    });
  });
}

function renderList() {
  const list = document.getElementById("categoryList");
  const counter = document.getElementById("categoryCounter");
  if (!state.items.length) {
    list.innerHTML = "<p>В approved папке нет фото под текущий фильтр.</p>";
    counter.textContent = "0 / 0";
    return;
  }
  counter.textContent = `${state.activeIndex + 1} / ${state.items.length}`;
  const start = Math.max(0, state.activeIndex - state.windowRadius);
  const end = Math.min(state.items.length, state.activeIndex + state.windowRadius + 1);
  list.innerHTML = state.items
    .slice(start, end)
    .map((item, offset) => {
      const index = start + offset;
      const active = index === state.activeIndex ? "active" : "";
      return `
        <article class="pair-item ${active}" data-index="${index}">
          <strong>${item.file_name}</strong>
          <div>${item.root_name}</div>
          <span class="tag">${item.effective_label}</span>
        </article>
      `;
    })
    .join("");
  list.querySelectorAll(".pair-item").forEach((node) => {
    node.addEventListener("click", () => {
      state.activeIndex = Number(node.dataset.index);
      renderCurrent();
    });
  });
}

function renderCurrent() {
  renderList();
  const item = currentItem();
  if (!item) {
    document.getElementById("categoryTitle").textContent = "Нет фото";
    document.getElementById("categoryImage").removeAttribute("src");
    document.getElementById("categoryMeta").textContent = "";
    return;
  }
  document.getElementById("categoryTitle").textContent = `${item.file_name} · ${item.effective_label}`;
  document.getElementById("categoryImage").src = item.media_url;
  document.getElementById("categoryMeta").innerHTML = `
    <strong>${item.file_name}</strong><br>
    ${item.width}x${item.height} · ${formatSize(item.size_bytes)}<br>
    ${item.path}
  `;
}

async function loadStats() {
  const payload = await api("/api/dashboard");
  renderSummary(payload.stats);
}

async function loadList(reset = false) {
  if (reset) {
    state.activeIndex = 0;
  }
  const payload = await api(`/api/categories?filter=${encodeURIComponent(state.filter)}&limit=5000&offset=0`);
  state.items = payload.items;
  state.categories = payload.categories;
  const filter = document.getElementById("categoryFilter");
  filter.innerHTML = ["all", "pending", "blocked", ...state.categories]
    .map((value) => `<option value="${value}">${value}</option>`)
    .join("");
  filter.value = state.filter;
  renderButtons();
  renderCurrent();
}

async function labelCurrent(label) {
  const item = currentItem();
  if (!item) return;
  await api(`/api/categories/${item.id}/label`, {
    method: "POST",
    body: JSON.stringify({ label }),
  });
  item.category_label = label === "clear" ? null : label;
  item.effective_label = item.category_label || "pending";
  renderCurrent();
  await loadStats();
}

function move(delta) {
  if (!state.items.length) return;
  state.activeIndex = Math.max(0, Math.min(state.items.length - 1, state.activeIndex + delta));
  renderCurrent();
}

async function runAi(force) {
  await api("/api/categories/run-ai", {
    method: "POST",
    body: JSON.stringify({ force }),
  });
  document.getElementById("categoryPlanBox").textContent = force
    ? "AI-категоризация всех approved фото запущена."
    : "AI-категоризация только необработанных approved фото запущена.";
}

async function showPlan() {
  const payload = await api("/api/categories/export-plan", { method: "POST", body: "{}" });
  document.getElementById("categoryPlanBox").textContent = JSON.stringify(payload, null, 2);
}

async function applyExport() {
  const accepted = confirm("Экспортировать все approved фото, у которых уже задана категория?");
  if (!accepted) return;
  await api("/api/categories/export", { method: "POST", body: "{}" });
  document.getElementById("categoryPlanBox").textContent = "Экспорт размеченных фото запущен.";
}

document.getElementById("categoryFilter").addEventListener("change", async (event) => {
  state.filter = event.target.value;
  await loadList(true);
});
document.getElementById("categoryPrevBtn").addEventListener("click", () => move(-1));
document.getElementById("categoryNextBtn").addEventListener("click", () => move(1));
document.getElementById("categoryAiBtn").addEventListener("click", () => runAi(false));
document.getElementById("categoryAiForceBtn").addEventListener("click", () => runAi(true));
document.getElementById("categoryPlanBtn").addEventListener("click", showPlan);
document.getElementById("categoryApplyBtn").addEventListener("click", applyExport);

window.addEventListener("keydown", async (event) => {
  if (event.target.matches("input, textarea, select")) return;
  if (event.key === "ArrowLeft") move(-1);
  if (event.key === "ArrowRight") move(1);
  if (["1", "2", "3", "4", "5"].includes(event.key)) {
    const index = Number(event.key) - 1;
    if (state.categories[index]) {
      await labelCurrent(state.categories[index]);
    }
  }
  if (event.key.toLowerCase() === "b") await labelCurrent("blocked");
  if (event.key.toLowerCase() === "c") await labelCurrent("clear");
});

loadStats();
loadList(true);
