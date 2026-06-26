const state = {
  overview: null,
  batches: [],
  selectedBatchUid: null,
  batchDetail: null,
  batchItems: [],
  selectedItemId: null,
  lastPairing: null,
};

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

function statusClass(value) {
  const map = {
    open: "status-chip--pending",
    completed: "status-chip--distinct",
    canceled: "status-chip--blocked",
    distinct: "status-chip--distinct",
    blocked: "status-chip--blocked",
    pending: "status-chip--pending",
    good: "status-chip--good",
    bad: "status-chip--bad",
    purge: "status-chip--purge",
    applied: "status-chip--good",
  };
  return map[value] || "status-chip--distinct";
}

function statusChip(label, value) {
  return `<span class="status-chip ${statusClass(value)}">${escapeHtml(label)}</span>`;
}

function formatTs(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return escapeHtml(value);
  return date.toLocaleString("ru-RU");
}

function summaryCard(label, value, detail = "") {
  return `<div><strong>${escapeHtml(label)}</strong><span>${escapeHtml(value)}</span><small>${escapeHtml(detail)}</small></div>`;
}

function currentBatch() {
  return state.batchDetail;
}

function currentItem() {
  return state.batchItems.find((item) => item.id === state.selectedItemId) || null;
}

function renderOverview() {
  const overview = state.overview;
  if (!overview) return;
  const stats = overview.stats || {};
  document.getElementById("mobileStats").innerHTML = [
    summaryCard("Устройства", stats.devices || 0, "Активные mobile devices"),
    summaryCard("Open", stats.open_batches || 0, "Открытые батчи"),
    summaryCard("Completed", stats.completed_batches || 0, "Закрытые успешно"),
    summaryCard("Canceled", stats.canceled_batches || 0, "Отмененные батчи"),
    summaryCard("Codes", stats.active_pairing_codes || 0, "Неиспользованные pairing-коды"),
  ].join("");

  document.getElementById("rootSummary").innerHTML = (overview.roots || [])
    .map(
      (root) => `
        <article class="config-item">
          <div class="config-item__label">${escapeHtml(root.root_name)}</div>
          <div class="config-item__value">
            Доступно: ${escapeHtml(root.available)} / ${escapeHtml(root.total)} ·
            Зарезервировано: ${escapeHtml(root.reserved)}
          </div>
        </article>
      `,
    )
    .join("") || '<div class="empty-state">Incoming-папки для телефона пока пусты.</div>';

  const deviceFilter = document.getElementById("batchDeviceFilter");
  const currentValue = deviceFilter.value;
  deviceFilter.innerHTML = `<option value="">Все устройства</option>${(overview.devices || [])
    .map((device) => `<option value="${escapeHtml(device.id)}">${escapeHtml(device.device_name)}</option>`)
    .join("")}`;
  deviceFilter.value = currentValue;

  const deviceList = document.getElementById("deviceList");
  if (!overview.devices?.length) {
    deviceList.innerHTML = '<div class="empty-state">Подключенных устройств пока нет.</div>';
    return;
  }
  deviceList.innerHTML = overview.devices
    .map(
      (device) => `
        <article class="queue-item mobile-device-card ${device.revoked_at ? "" : "is-live"}">
          <div class="pair-header">
            <div class="pair-header__meta">
              <strong>${escapeHtml(device.device_name)}</strong>
              <div class="badge-row">
                ${statusChip(device.revoked_at ? "revoked" : "active", device.revoked_at ? "blocked" : "good")}
                ${statusChip(`open ${device.open_batches || 0}`, "pending")}
                ${statusChip(`done ${device.completed_batches || 0}`, "distinct")}
              </div>
            </div>
            <div class="pair-actions">
              <button data-action="revoke-device" data-device-id="${device.id}" ${device.revoked_at ? "disabled" : ""} class="danger">
                Отозвать
              </button>
            </div>
          </div>
          <div class="meta-block">
            <div>ID: ${escapeHtml(device.id)}</div>
            <div>Создано: ${escapeHtml(formatTs(device.created_at))}</div>
            <div>Последняя активность: ${escapeHtml(formatTs(device.last_seen_at))}</div>
            <div>Revoked: ${escapeHtml(formatTs(device.revoked_at))}</div>
          </div>
        </article>
      `,
    )
    .join("");
}

function renderPairingCode() {
  const node = document.getElementById("pairingCodeBox");
  if (!state.lastPairing) {
    node.innerHTML = '<div class="empty-state">Код подключения еще не сгенерирован.</div>';
    return;
  }
  node.innerHTML = `
    <div class="mobile-pairing-card">
      <div class="mobile-pairing-card__code">${escapeHtml(state.lastPairing.code)}</div>
      <div class="meta-block">
        <div>Создан: ${escapeHtml(formatTs(state.lastPairing.created_at))}</div>
        <div>Истекает: ${escapeHtml(formatTs(state.lastPairing.expires_at))}</div>
      </div>
    </div>
  `;
}

function renderBatchList() {
  const node = document.getElementById("batchList");
  if (!state.batches.length) {
    node.innerHTML = '<div class="empty-state">Под текущие фильтры батчи не найдены.</div>';
    return;
  }
  node.innerHTML = state.batches
    .map((batch) => {
      const counts = batch.counts || {};
      const active = batch.uid === state.selectedBatchUid ? "active" : "";
      return `
        <article class="queue-item ${active}" data-batch-uid="${escapeHtml(batch.uid)}">
          <div class="pair-header">
            <div class="pair-header__meta">
              <strong>${escapeHtml(batch.name)}</strong>
              <div class="badge-row">
                ${statusChip(batch.status, batch.status)}
                ${statusChip(batch.device_name || `device ${batch.device_id}`, "distinct")}
              </div>
            </div>
          </div>
          <div class="meta-block">
            <div>UID: ${escapeHtml(batch.uid)}</div>
            <div>Папки: ${escapeHtml((batch.selected_roots || []).join(", ") || "все incoming")}</div>
            <div>Прогресс: ${escapeHtml(batch.cursor_index)} / ${escapeHtml(batch.total_items)}</div>
            <div>Решения: good ${escapeHtml(counts.good || 0)} · bad ${escapeHtml(counts.bad || 0)} · purge ${escapeHtml(counts.purge || 0)} · pending ${escapeHtml(counts.pending || 0)}</div>
            <div>Обновлен: ${escapeHtml(formatTs(batch.updated_at))}</div>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderBatchMeta() {
  const node = document.getElementById("batchMeta");
  const batch = currentBatch();
  if (!batch) {
    node.innerHTML = '<div class="empty-state">Выбери батч слева, чтобы посмотреть детали.</div>';
    return;
  }
  const counts = batch.counts || {};
  const isOpen = batch.status === "open";
  node.innerHTML = `
    <div class="section-head">
      <div>
        <p class="eyebrow">Batch Detail</p>
        <h3>${escapeHtml(batch.name)}</h3>
      </div>
      <div class="badge-row">
        ${statusChip(batch.status, batch.status)}
        ${statusChip(batch.device_name || `device ${batch.device_id}`, "distinct")}
      </div>
    </div>
    <div class="summary-grid summary-grid--compact">
      ${summaryCard("Всего", counts.total || batch.total_items || 0, "Элементов в батче")}
      ${summaryCard("Pending", counts.pending || 0, "Еще без решения")}
      ${summaryCard("Good", counts.good || 0, "Пойдут в approved")}
      ${summaryCard("Bad", counts.bad || 0, "Пойдут в rejected")}
      ${summaryCard("Purge", counts.purge || 0, "Жесткое удаление")}
      ${summaryCard("Originals", batch.available_originals || 0, "Оригиналы еще доступны")}
    </div>
    <div class="meta-block">
      <div>UID: ${escapeHtml(batch.uid)}</div>
      <div>Папки: ${escapeHtml((batch.selected_roots || []).join(", ") || "все incoming")}</div>
      <div>Курсор телефона: ${escapeHtml(batch.cursor_index)} / ${escapeHtml(batch.total_items)}</div>
      <div>Создан: ${escapeHtml(formatTs(batch.created_at))}</div>
      <div>Обновлен: ${escapeHtml(formatTs(batch.updated_at))}</div>
      <div>Завершен: ${escapeHtml(formatTs(batch.completed_at))}</div>
    </div>
    <div class="action-grid">
      <button data-action="plan-batch">Показать план</button>
      <button data-action="apply-batch" class="primary" ${isOpen ? "" : "disabled"}>Применить просмотренное</button>
      <button data-action="complete-batch" ${isOpen ? "" : "disabled"}>Закрыть батч</button>
      <button data-action="cancel-batch" class="danger" ${isOpen ? "" : "disabled"}>Отменить батч</button>
    </div>
  `;
}

function renderBatchItems() {
  const node = document.getElementById("batchItems");
  if (!state.batchItems.length) {
    node.innerHTML = '<div class="empty-state">В выбранном батче нет элементов.</div>';
    return;
  }
  node.innerHTML = state.batchItems
    .map((item) => {
      const active = item.id === state.selectedItemId ? "active" : "";
      const decision = item.applied_action || item.decision || "pending";
      return `
        <article class="queue-item ${active}" data-item-id="${item.id}">
          <div class="pair-header">
            <div class="pair-header__meta">
              <strong>#${escapeHtml(item.position + 1)} ${escapeHtml(item.file_name)}</strong>
              <div class="badge-row">
                ${statusChip(item.applied_action ? `applied ${item.applied_action}` : decision, decision)}
                ${statusChip(item.is_available ? "available" : "missing", item.is_available ? "good" : "blocked")}
              </div>
            </div>
          </div>
          <div class="meta-block">
            <div>${escapeHtml(item.root_name)} · ${escapeHtml(item.width)}×${escapeHtml(item.height)}</div>
            <div>Решение: ${escapeHtml(item.decision || "pending")}</div>
            <div>Синхронизировано: ${escapeHtml(formatTs(item.client_updated_at))}</div>
            <div>Применено: ${escapeHtml(formatTs(item.applied_at))}</div>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderItemPreview() {
  const node = document.getElementById("itemPreview");
  const item = currentItem();
  if (!item) {
    node.innerHTML = '<div class="empty-state">Выбери элемент батча для предпросмотра.</div>';
    return;
  }
  node.innerHTML = `
    <div class="image-shell image-shell--single mobile-preview-image">
      ${
        item.preview_url
          ? `<img src="${escapeHtml(item.preview_url)}" alt="${escapeHtml(item.file_name)}">`
          : '<div class="empty-state">Оригинал больше не доступен в библиотеке.</div>'
      }
    </div>
    <div class="meta-block">
      <div><strong>${escapeHtml(item.file_name)}</strong></div>
      <div>Позиция: ${escapeHtml(item.position + 1)}</div>
      <div>Решение: ${escapeHtml(item.decision || "pending")}</div>
      <div>Применено: ${escapeHtml(item.applied_action || "нет")}</div>
      <div>Размер: ${escapeHtml(item.width)}×${escapeHtml(item.height)}</div>
      <div>Путь: ${escapeHtml(item.current_path || "файл уже перемещен или удален")}</div>
    </div>
  `;
}

async function refreshOverview() {
  state.overview = await api("/api/mobile-admin/overview");
  renderOverview();
}

async function refreshBatches() {
  const status = document.getElementById("batchStatusFilter").value;
  const deviceId = document.getElementById("batchDeviceFilter").value;
  const params = new URLSearchParams();
  params.set("status", status);
  if (deviceId) params.set("device_id", deviceId);
  const payload = await api(`/api/mobile-admin/batches?${params.toString()}`);
  state.batches = payload.items || [];
  if (!state.batches.some((batch) => batch.uid === state.selectedBatchUid)) {
    state.selectedBatchUid = state.batches[0]?.uid || null;
  }
  renderBatchList();
}

async function loadSelectedBatch() {
  if (!state.selectedBatchUid) {
    state.batchDetail = null;
    state.batchItems = [];
    state.selectedItemId = null;
    renderBatchMeta();
    renderBatchItems();
    renderItemPreview();
    return;
  }
  state.batchDetail = await api(`/api/mobile-admin/batches/${encodeURIComponent(state.selectedBatchUid)}`);
  const itemsPayload = await api(`/api/mobile-admin/batches/${encodeURIComponent(state.selectedBatchUid)}/items?limit=500&offset=0`);
  state.batchItems = itemsPayload.items || [];
  if (!state.batchItems.some((item) => item.id === state.selectedItemId)) {
    state.selectedItemId = state.batchItems[0]?.id || null;
  }
  renderBatchMeta();
  renderBatchItems();
  renderItemPreview();
}

async function refreshAll() {
  try {
    await refreshOverview();
    await refreshBatches();
    await loadSelectedBatch();
  } catch (error) {
    alert(error.message);
  }
}

async function generatePairingCode() {
  try {
    state.lastPairing = await api("/api/mobile-admin/pairing-code", {
      method: "POST",
      body: JSON.stringify({ ttl_minutes: Number(document.getElementById("pairingTtl").value) }),
    });
    renderPairingCode();
    await refreshOverview();
  } catch (error) {
    alert(error.message);
  }
}

async function revokeDevice(deviceId) {
  const accepted = confirm("Отозвать устройство и отменить все его open-батчи?");
  if (!accepted) return;
  try {
    await api(`/api/mobile-admin/devices/${deviceId}/revoke`, { method: "POST", body: "{}" });
    await refreshAll();
  } catch (error) {
    alert(error.message);
  }
}

async function showBatchPlan() {
  const batch = currentBatch();
  if (!batch) return;
  try {
    const payload = await api(`/api/mobile-admin/batches/${encodeURIComponent(batch.uid)}/apply-plan`, { method: "POST", body: "{}" });
    const header = payload.auto_bad_pending
      ? `Авто-bad: ${payload.auto_bad_pending} pending-фото будут отправлены в rejected, потому что батч долистан до конца.\n\n`
      : "";
    document.getElementById("mobilePlanBox").textContent = `${header}${JSON.stringify(payload, null, 2)}`;
  } catch (error) {
    alert(error.message);
  }
}

async function applyBatch() {
  const batch = currentBatch();
  if (!batch) return;
  try {
    const plan = await api(`/api/mobile-admin/batches/${encodeURIComponent(batch.uid)}/apply-plan`, { method: "POST", body: "{}" });
    if (!plan.total) {
      alert("Для применения сейчас нет просмотренных элементов.");
      document.getElementById("mobilePlanBox").textContent = JSON.stringify(plan, null, 2);
      return;
    }
    let prompt = `Применить ${plan.total} действий для батча?`;
    if (plan.auto_bad_pending) {
      prompt += `\n${plan.auto_bad_pending} нелайкнутых фото автоматически уйдут в bad.`;
    }
    if (plan.requires_purge_confirmation) {
      prompt += "\nВ плане есть purge-операции.";
    }
    const accepted = confirm(prompt);
    if (!accepted) return;
    await api(`/api/mobile-admin/batches/${encodeURIComponent(batch.uid)}/apply`, {
      method: "POST",
      body: JSON.stringify({ confirm_purge: plan.requires_purge_confirmation }),
    });
    await refreshAll();
    document.getElementById("mobilePlanBox").textContent = "Батч применен.";
  } catch (error) {
    alert(error.message);
  }
}

async function cancelBatch() {
  const batch = currentBatch();
  if (!batch) return;
  const accepted = confirm("Отменить батч и освободить его непримененные элементы?");
  if (!accepted) return;
  try {
    await api(`/api/mobile-admin/batches/${encodeURIComponent(batch.uid)}/cancel`, { method: "POST", body: "{}" });
    await refreshAll();
  } catch (error) {
    alert(error.message);
  }
}

async function completeBatch() {
  const batch = currentBatch();
  if (!batch) return;
  const accepted = confirm("Пометить батч завершенным? Это снимет его с active-очереди.");
  if (!accepted) return;
  try {
    await api(`/api/mobile-admin/batches/${encodeURIComponent(batch.uid)}/complete`, { method: "POST", body: "{}" });
    await refreshAll();
  } catch (error) {
    alert(error.message);
  }
}

document.getElementById("mobileRefreshBtn").addEventListener("click", refreshAll);
document.getElementById("pairingCodeBtn").addEventListener("click", generatePairingCode);
document.getElementById("batchStatusFilter").addEventListener("change", async () => {
  await refreshBatches();
  await loadSelectedBatch();
});
document.getElementById("batchDeviceFilter").addEventListener("change", async () => {
  await refreshBatches();
  await loadSelectedBatch();
});

document.getElementById("deviceList").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action='revoke-device']");
  if (!button) return;
  await revokeDevice(button.dataset.deviceId);
});

document.getElementById("batchList").addEventListener("click", async (event) => {
  const card = event.target.closest("[data-batch-uid]");
  if (!card) return;
  state.selectedBatchUid = card.dataset.batchUid;
  renderBatchList();
  await loadSelectedBatch();
});

document.getElementById("batchMeta").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  if (button.dataset.action === "plan-batch") await showBatchPlan();
  if (button.dataset.action === "apply-batch") await applyBatch();
  if (button.dataset.action === "cancel-batch") await cancelBatch();
  if (button.dataset.action === "complete-batch") await completeBatch();
});

document.getElementById("batchItems").addEventListener("click", (event) => {
  const card = event.target.closest("[data-item-id]");
  if (!card) return;
  state.selectedItemId = Number(card.dataset.itemId);
  renderBatchItems();
  renderItemPreview();
});

renderPairingCode();
refreshAll();
