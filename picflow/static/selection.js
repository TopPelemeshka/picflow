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
  filter: "all",
  items: [],
  offset: 0,
  activeIndex: 0,
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

function renderList() {
  const list = document.getElementById("selectionList");
  if (!state.items.length) {
    list.innerHTML = "<p>Во входящих папках нет фотографий под текущий фильтр.</p>";
    return;
  }
  list.innerHTML = state.items
    .map((item, index) => {
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

function currentItem() {
  return state.items[state.activeIndex];
}

function renderCurrent() {
  renderList();
  const item = currentItem();
  if (!item) {
    document.getElementById("selectionTitle").textContent = "Нет фото";
    document.getElementById("selectionImage").removeAttribute("src");
    document.getElementById("selectionMeta").textContent = "";
    return;
  }
  document.getElementById("selectionTitle").textContent = `${item.file_name} • ${item.effective_label}`;
  document.getElementById("selectionImage").src = item.media_url;
  document.getElementById("selectionMeta").innerHTML = `
    <strong>${item.file_name}</strong><br>
    ${item.root_name} • ${item.width}×${item.height} • ${formatSize(item.size_bytes)}<br>
    ${item.path}
  `;
}

async function loadList(reset = false) {
  if (reset) {
    state.offset = 0;
    state.activeIndex = 0;
  }
  const payload = await api(`/api/selection?filter=${encodeURIComponent(state.filter)}&limit=150&offset=${state.offset}`);
  state.items = payload.items;
  renderCurrent();
}

async function labelCurrent(label) {
  const item = currentItem();
  if (!item) return;
  await api(`/api/selection/${item.id}/label`, {
    method: "POST",
    body: JSON.stringify({ label }),
  });
  if (label === "good") item.selection_label = "good";
  if (label === "bad") item.selection_label = "bad";
  if (label === "clear") item.selection_label = null;
  item.effective_label = item.selection_label || "pending";
  renderCurrent();
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
  const accepted = confirm("Разобрать все входящие фото от начала очереди до текущего?");
  if (!accepted) return;
  await api("/api/selection/apply", {
    method: "POST",
    body: JSON.stringify({ through_image_id: item.id }),
  });
  document.getElementById("selectionPlanBox").textContent = "Запущена фоновая задача разбора.";
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

loadList(true);
