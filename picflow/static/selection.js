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
  items: [],
  activeIndex: 0,
  batchSize: 200,
};

function currentItem() {
  return state.items[state.activeIndex];
}

function isLiked(item) {
  return item?.selection_label === "good";
}

function batchStart() {
  return Math.floor(state.activeIndex / state.batchSize) * state.batchSize;
}

function batchEndExclusive() {
  return Math.min(state.items.length, batchStart() + state.batchSize);
}

function batchItems() {
  return state.items.slice(batchStart(), batchEndExclusive());
}

function renderSummary(stats) {
  const selection = stats.selection || {};
  const total = selection.total || 0;
  const liked = selection.good || 0;
  const unmarked = Math.max(0, total - liked);
  const currentBatch = batchItems();
  const batchLiked = currentBatch.filter(isLiked).length;
  const batchUnmarked = Math.max(0, currentBatch.length - batchLiked);
  document.getElementById("selectionSummary").innerHTML = [
    `<div><strong>В пачке</strong><span>${currentBatch.length}</span></div>`,
    `<div><strong>Лайков в пачке</strong><span>${batchLiked}</span></div>`,
    `<div><strong>Без лайка в пачке</strong><span>${batchUnmarked}</span></div>`,
    `<div><strong>Всего входящих</strong><span>${total}</span></div>`,
    `<div><strong>Всего лайков</strong><span>${liked}</span></div>`,
    `<div><strong>Всего без лайка</strong><span>${unmarked}</span></div>`,
  ].join("");
}

function renderCurrent() {
  const item = currentItem();
  const likeButton = document.getElementById("selectionLikeBtn");
  const likeBadge = document.getElementById("selectionLikeBadge");
  const image = document.getElementById("selectionImage");

  if (!item) {
    document.getElementById("selectionTitle").textContent = "Нет фото";
    document.getElementById("selectionMeta").textContent = "";
    document.getElementById("selectionCounter").textContent = "0 / 0";
    document.getElementById("selectionBatchMeta").textContent = "Пачка 0";
    image.removeAttribute("src");
    likeButton.textContent = "Нравится";
    likeBadge.textContent = "Без лайка";
    likeBadge.classList.remove("is-active");
    return;
  }

  const liked = isLiked(item);
  const batchStartIndex = batchStart();
  const batchEndIndex = batchEndExclusive();
  document.getElementById("selectionCounter").textContent = `${state.activeIndex + 1} / ${state.items.length}`;
  document.getElementById("selectionBatchMeta").textContent = `Пачка ${batchStartIndex + 1}-${batchEndIndex}`;
  document.getElementById("selectionTitle").textContent = item.file_name;
  image.src = item.media_url;
  document.getElementById("selectionMeta").innerHTML = `
    <strong>${escapeHtml(item.file_name)}</strong><br>
    ${escapeHtml(item.root_name)} · ${item.width}x${item.height} · ${formatSize(item.size_bytes)}<br>
    ${escapeHtml(item.path)}
  `;
  likeButton.textContent = liked ? "Убрать лайк" : "Нравится";
  likeButton.classList.toggle("primary", !liked);
  likeBadge.textContent = liked ? "Нравится" : "Без лайка";
  likeBadge.classList.toggle("is-active", liked);
}

async function loadStats() {
  const payload = await api("/api/dashboard");
  renderSummary(payload.stats);
}

async function loadList(reset = false) {
  const payload = await api("/api/selection?filter=all&limit=5000&offset=0");
  state.items = payload.items;
  if (reset) {
    state.activeIndex = 0;
  }
  if (state.activeIndex >= state.items.length) {
    state.activeIndex = Math.max(0, state.items.length - 1);
  }
  renderCurrent();
}

async function setLiked(liked) {
  const item = currentItem();
  if (!item) return;
  const label = liked ? "good" : "clear";
  await api(`/api/selection/${item.id}/label`, {
    method: "POST",
    body: JSON.stringify({ label }),
  });
  item.selection_label = liked ? "good" : null;
  item.effective_label = liked ? "liked" : "auto-reject";
  renderCurrent();
  await loadStats();
}

async function toggleLiked() {
  const item = currentItem();
  if (!item) return;
  await setLiked(!isLiked(item));
}

function move(delta) {
  if (!state.items.length) return;
  state.activeIndex = Math.max(0, Math.min(state.items.length - 1, state.activeIndex + delta));
  renderCurrent();
  void loadStats();
}

async function showPlan() {
  const payload = await api("/api/selection/apply-plan", {
    method: "POST",
    body: JSON.stringify({ batch_offset: batchStart(), batch_size: state.batchSize }),
  });
  document.getElementById("selectionPlanBox").textContent = JSON.stringify(payload, null, 2);
}

async function applySelection() {
  if (!currentItem()) return;
  const start = batchStart() + 1;
  const end = batchEndExclusive();
  const accepted = confirm(`Разнести только текущую пачку ${start}-${end}?`);
  if (!accepted) return;
  await api("/api/selection/apply", {
    method: "POST",
    body: JSON.stringify({ batch_offset: batchStart(), batch_size: state.batchSize }),
  });
  document.getElementById("selectionPlanBox").textContent = "Задача разноса текущей пачки запущена.";
}

document.getElementById("selectionBatchSize").addEventListener("change", async (event) => {
  state.batchSize = Number(event.target.value) || 200;
  renderCurrent();
  await loadStats();
});

document.getElementById("selectionLikeBtn").addEventListener("click", toggleLiked);
document.getElementById("selectionLikeBadge").addEventListener("click", toggleLiked);
document.getElementById("selectionPrevBtn").addEventListener("click", () => move(-1));
document.getElementById("selectionNextBtn").addEventListener("click", () => move(1));
document.getElementById("selectionPlanBtn").addEventListener("click", showPlan);
document.getElementById("selectionApplyBtn").addEventListener("click", applySelection);
document.getElementById("selectionImage").addEventListener("click", toggleLiked);

window.addEventListener("keydown", async (event) => {
  if (event.target.matches("input, textarea, select")) return;
  if (event.code === "ArrowLeft") {
    event.preventDefault();
    move(-1);
    return;
  }
  if (event.code === "ArrowRight") {
    event.preventDefault();
    move(1);
    return;
  }
  if (event.code === "Space" || event.code === "KeyL" || event.code === "Enter") {
    event.preventDefault();
    await toggleLiked();
    return;
  }
  if (event.code === "KeyC" || event.code === "Delete" || event.code === "Backspace") {
    event.preventDefault();
    await setLiked(false);
  }
});

loadStats();
loadList(true);
