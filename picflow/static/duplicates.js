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
  filter: "needs-review",
  items: [],
  activeIndex: 0,
  windowRadius: 20,
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
  const candidates = stats.candidates || {};
  document.getElementById("duplicatesSummary").innerHTML = [
    `<div><strong>Всего пар:</strong> ${candidates.total || 0}</div>`,
    `<div><strong>Дубликаты:</strong> ${candidates.duplicate || 0}</div>`,
    `<div><strong>Blocked:</strong> ${candidates.blocked || 0}</div>`,
    `<div><strong>Distinct:</strong> ${candidates.distinct || 0}</div>`,
  ].join("");
}

function renderList() {
  const list = document.getElementById("pairList");
  const counter = document.getElementById("pairCounter");
  if (!state.items.length) {
    list.innerHTML = "<p>Для текущего фильтра пары не найдены.</p>";
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
          <strong>#${item.id}</strong>
          <div>${item.left_root_name} <-> ${item.right_root_name}</div>
          <div>score: ${item.candidate_score}</div>
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
  const title = document.getElementById("pairTitle");
  if (!item) {
    title.textContent = "Пара не выбрана";
    document.getElementById("leftImage").removeAttribute("src");
    document.getElementById("rightImage").removeAttribute("src");
    document.getElementById("metricsBox").innerHTML = "";
    document.getElementById("reasonBox").textContent = "";
    return;
  }
  title.textContent = `#${item.id} · ${item.effective_label}`;
  document.getElementById("leftImage").src = item.left_media_url;
  document.getElementById("rightImage").src = item.right_media_url;
  document.getElementById("leftMeta").innerHTML = `
    <strong>${item.left_file_name}</strong><br>
    ${item.left_root_name} · ${item.left_width}x${item.left_height} · ${formatSize(item.left_size_bytes)}<br>
    ${item.left_path}
  `;
  document.getElementById("rightMeta").innerHTML = `
    <strong>${item.right_file_name}</strong><br>
    ${item.right_root_name} · ${item.right_width}x${item.right_height} · ${formatSize(item.right_size_bytes)}<br>
    ${item.right_path}
  `;
  document.getElementById("metricsBox").innerHTML = [
    ["Score", item.candidate_score],
    ["Exact", item.exact_hash_match],
    ["pHash", item.phash_distance],
    ["dHash", item.dhash_distance],
    ["aHash", item.ahash_distance],
    ["Center pHash", item.center_phash_distance],
    ["Center dHash", item.center_dhash_distance],
    ["Size ratio", item.size_ratio],
  ]
    .map(([label, value]) => `<div class="metric"><strong>${label}</strong><div>${value}</div></div>`)
    .join("");
  const reason = {
    ai_label: item.ai_label,
    ai_confidence: item.ai_confidence,
    ai_reason: item.ai_reason,
    manual_label: item.manual_label,
    raw: item.ai_raw_response,
  };
  document.getElementById("reasonBox").textContent = JSON.stringify(reason, null, 2);
}

async function loadStats() {
  const payload = await api("/api/dashboard");
  renderSummary(payload.stats);
}

async function loadList(reset = false) {
  if (reset) {
    state.activeIndex = 0;
  }
  const payload = await api(`/api/duplicates?filter=${encodeURIComponent(state.filter)}&limit=5000&offset=0`);
  state.items = payload.items;
  renderCurrent();
}

async function labelCurrent(label) {
  const item = currentItem();
  if (!item) return;
  await api(`/api/duplicates/${item.id}/label`, {
    method: "POST",
    body: JSON.stringify({ label }),
  });
  await loadList(false);
  await loadStats();
}

function move(delta) {
  if (!state.items.length) return;
  state.activeIndex = Math.max(0, Math.min(state.items.length - 1, state.activeIndex + delta));
  renderCurrent();
}

async function showDeletePlan() {
  const payload = await api("/api/duplicates/apply-plan", { method: "POST", body: "{}" });
  document.getElementById("deletePlanBox").textContent = JSON.stringify(payload, null, 2);
}

async function runVerify(force) {
  await api("/api/verify", {
    method: "POST",
    body: JSON.stringify({ force }),
  });
  document.getElementById("deletePlanBox").textContent = force
    ? "AI-проверка всех пар запущена в фоне."
    : "AI-проверка необработанных пар запущена в фоне.";
}

async function applyDeletePlan() {
  const accepted = confirm("Применить удаление всех пар, которые помечены как duplicate?");
  if (!accepted) return;
  await api("/api/duplicates/apply", { method: "POST", body: "{}" });
  document.getElementById("deletePlanBox").textContent = "Применение плана удаления запущено.";
}

document.getElementById("filterSelect").addEventListener("change", async (event) => {
  state.filter = event.target.value;
  await loadList(true);
});

document.querySelectorAll("[data-label]").forEach((button) => {
  button.addEventListener("click", async () => {
    await labelCurrent(button.dataset.label);
  });
});

document.getElementById("prevBtn").addEventListener("click", () => move(-1));
document.getElementById("nextBtn").addEventListener("click", () => move(1));
document.getElementById("verifyPendingBtn").addEventListener("click", () => runVerify(false));
document.getElementById("verifyForceBtn").addEventListener("click", () => runVerify(true));
document.getElementById("showDeletePlanBtn").addEventListener("click", showDeletePlan);
document.getElementById("applyDeletePlanBtn").addEventListener("click", applyDeletePlan);

window.addEventListener("keydown", async (event) => {
  if (event.target.matches("input, textarea, select")) return;
  if (event.key === "ArrowLeft") move(-1);
  if (event.key === "ArrowRight") move(1);
  if (event.key.toLowerCase() === "d") await labelCurrent("duplicate");
  if (event.key.toLowerCase() === "n") await labelCurrent("distinct");
  if (event.key.toLowerCase() === "b") await labelCurrent("blocked");
  if (event.key.toLowerCase() === "c") await labelCurrent("clear");
});

loadStats();
loadList(true);
