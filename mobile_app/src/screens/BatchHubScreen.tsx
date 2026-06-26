import { useState } from "react";
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { AppButton } from "../components/AppButton";
import { ScreenShell } from "../components/ScreenShell";
import { StatusChip } from "../components/StatusChip";
import { theme } from "../lib/theme";
import type { CachedBatch, CachedSession, MobileRoot, RemoteBatch, RemoteCapabilities } from "../types";

type Props = {
  session: CachedSession;
  capabilities: RemoteCapabilities | null;
  roots: MobileRoot[];
  remoteBatches: RemoteBatch[];
  localBatches: Record<string, CachedBatch>;
  activeBatchUid: string | null;
  busy: string | null;
  error: string | null;
  onDisconnect: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onCreateBatch: (rootNames: string[], batchSize: number, name?: string) => Promise<void>;
  onDownloadBatch: (batchUid: string) => Promise<void>;
  onSyncBatch: (batchUid: string) => Promise<void>;
  onOpenBatch: (batchUid: string) => void;
  onRemoveBatch: (batchUid: string) => Promise<void>;
};

type HubScope = "all" | "local" | "unsynced" | "server";

function formatTime(value: string | null): string {
  if (!value) {
    return "еще не синхронизировалось";
  }
  const stamp = new Date(value);
  if (Number.isNaN(stamp.getTime())) {
    return value;
  }
  return stamp.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function batchDecisionSummary(batch: CachedBatch | RemoteBatch) {
  const counts = "batch" in batch ? batch.batch.counts || {} : batch.counts || {};
  return `good ${counts.good || 0} · bad ${counts.bad || 0} · purge ${counts.purge || 0} · pending ${counts.pending || 0}`;
}

export function BatchHubScreen({
  session,
  capabilities,
  roots,
  remoteBatches,
  localBatches,
  activeBatchUid,
  busy,
  error,
  onDisconnect,
  onRefresh,
  onCreateBatch,
  onDownloadBatch,
  onSyncBatch,
  onOpenBatch,
  onRemoveBatch,
}: Props) {
  const [selectedRoots, setSelectedRoots] = useState<string[]>([]);
  const [batchSize, setBatchSize] = useState("2000");
  const [batchName, setBatchName] = useState("");
  const [scope, setScope] = useState<HubScope>("all");

  const downloadedBatches = Object.values(localBatches).sort(
    (left, right) => new Date(right.localUpdatedAt).getTime() - new Date(left.localUpdatedAt).getTime(),
  );
  const remoteBatchesSorted = [...remoteBatches].sort((left, right) => {
    if (left.status !== right.status) {
      return left.status === "open" ? -1 : 1;
    }
    return new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime();
  });
  const activeBatch = activeBatchUid ? localBatches[activeBatchUid] ?? null : null;
  const localPending = downloadedBatches.reduce((sum, batch) => sum + (batch.batch.counts.pending || 0), 0);
  const localDirty = downloadedBatches.reduce(
    (sum, batch) => sum + batch.items.filter((item) => item.sync_state === "dirty").length,
    0,
  );
  const localPurge = downloadedBatches.reduce((sum, batch) => sum + (batch.batch.counts.purge || 0), 0);
  const visibleDownloadedBatches = downloadedBatches.filter((batch) => {
    if (scope === "local") return true;
    if (scope === "unsynced") return batch.items.some((item) => item.sync_state === "dirty");
    if (scope === "server") return false;
    return true;
  });
  const visibleRemoteBatches = remoteBatchesSorted.filter((batch) => {
    if (scope === "local") return false;
    if (scope === "unsynced") return Boolean(localBatches[batch.uid]?.items.some((item) => item.sync_state === "dirty"));
    if (scope === "server") return true;
    return true;
  });

  async function create() {
    const numericSize = Number(batchSize);
    await onCreateBatch(selectedRoots, Number.isFinite(numericSize) ? numericSize : 2000, batchName || undefined);
  }

  function confirmRemove(batchUid: string) {
    Alert.alert("Удалить батч?", "Он исчезнет с телефона и с сервера. Используй это только для завершенного или отмененного батча.", [
      { text: "Отмена", style: "cancel" },
      { text: "Удалить", style: "destructive", onPress: () => void onRemoveBatch(batchUid) },
    ]);
  }

  return (
    <ScreenShell
      title="Батчи и офлайн-кэш"
      subtitle={`Подключено как ${session.deviceName}. Здесь выбираются папки, скачиваются оригиналы и открываются незавершенные батчи.`}
      headerRight={<AppButton label="Отключить" onPress={() => void onDisconnect()} tone="ghost" />}
    >
      <View style={styles.actionsRow}>
        <AppButton label={busy ?? "Обновить сервер"} onPress={() => void onRefresh()} tone="primary" disabled={Boolean(busy)} />
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Сводка</Text>
        <View style={styles.summaryGrid}>
          <View style={styles.summaryTile}>
            <Text style={styles.summaryValue}>{downloadedBatches.length}</Text>
            <Text style={styles.summaryLabel}>локальных батчей</Text>
          </View>
          <View style={styles.summaryTile}>
            <Text style={styles.summaryValue}>{localPending}</Text>
            <Text style={styles.summaryLabel}>неразмечено</Text>
          </View>
          <View style={styles.summaryTile}>
            <Text style={styles.summaryValue}>{localDirty}</Text>
            <Text style={styles.summaryLabel}>ждут sync</Text>
          </View>
          <View style={styles.summaryTile}>
            <Text style={styles.summaryValue}>{localPurge}</Text>
            <Text style={styles.summaryLabel}>помечено purge</Text>
          </View>
        </View>
        {activeBatch ? (
          <View style={styles.resumeCard}>
            <View style={styles.batchCopy}>
              <Text style={styles.batchTitle}>Продолжить с места остановки</Text>
              <Text style={styles.batchMeta}>{activeBatch.batch.name}</Text>
              <Text style={styles.batchMeta}>
                курсор {activeBatch.batch.cursor_index + 1} / {activeBatch.items.length} · sync {formatTime(activeBatch.lastSyncedAt)}
              </Text>
            </View>
            <AppButton label="Продолжить" onPress={() => onOpenBatch(activeBatch.batch.uid)} tone="primary" />
          </View>
        ) : null}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Новый батч</Text>
        <Text style={styles.cardText}>
          Телефон скачивает оригиналы выбранных incoming-папок и потом может разбирать их без сети. Нормальный режим здесь
          уже не сотни, а тысячи фото: скачал один большой набор и идешь по нему постепенно.
        </Text>
        <View style={styles.inlineButtons}>
          <AppButton
            label="Выбрать все"
            onPress={() => setSelectedRoots(roots.map((root) => root.root_name))}
            style={styles.inlineButton}
          />
          <AppButton label="Очистить" onPress={() => setSelectedRoots([])} style={styles.inlineButton} />
        </View>
        <View style={styles.rootChips}>
          {roots.map((root) => {
            const selected = selectedRoots.includes(root.root_name);
            return (
              <Pressable
                key={root.root_name}
                onPress={() =>
                  setSelectedRoots((current) =>
                    current.includes(root.root_name)
                      ? current.filter((item) => item !== root.root_name)
                      : [...current, root.root_name],
                  )
                }
                style={[styles.rootChip, selected && styles.rootChipSelected]}
              >
                <Text style={[styles.rootChipLabel, selected && styles.rootChipLabelSelected]}>{root.root_name}</Text>
                <Text style={styles.rootChipMeta}>доступно {root.available}</Text>
              </Pressable>
            );
          })}
        </View>
        <Text style={styles.cardText}>
          {selectedRoots.length
            ? `В батч попадут только: ${selectedRoots.join(", ")}`
            : "Если папки не выбраны, сервер возьмет все доступные incoming-папки."}
        </Text>
        <View style={styles.scopeRow}>
          {["500", "2000", "5000"].map((size) => (
            <AppButton
              key={size}
              label={`${size} фото`}
              onPress={() => setBatchSize(size)}
              tone={batchSize === size ? "primary" : "soft"}
              style={styles.scopeButton}
            />
          ))}
        </View>

        <TextInput
          keyboardType="number-pad"
          onChangeText={setBatchSize}
          placeholder="2000"
          placeholderTextColor="#958f88"
          style={styles.input}
          value={batchSize}
        />
        <TextInput
          onChangeText={setBatchName}
          placeholder="Название батча, необязательно"
          placeholderTextColor="#958f88"
          style={styles.input}
          value={batchName}
        />
        <AppButton label="Создать и скачать батч" onPress={() => void create()} tone="primary" disabled={Boolean(busy)} />
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Скачанные батчи</Text>
        <View style={styles.scopeRow}>
          {[
            { value: "all", label: "Все" },
            { value: "local", label: "Локальные" },
            { value: "unsynced", label: "Требуют sync" },
            { value: "server", label: "Только сервер" },
          ].map((item) => (
            <AppButton
              key={item.value}
              label={item.label}
              onPress={() => setScope(item.value as HubScope)}
              tone={scope === item.value ? "primary" : "soft"}
              style={styles.scopeButton}
            />
          ))}
        </View>
        {!visibleDownloadedBatches.length ? <Text style={styles.cardText}>Под текущий фильтр локальных батчей нет.</Text> : null}
        {visibleDownloadedBatches.map((cached) => {
          const downloadedCount = cached.items.filter((item) => item.local_uri).length;
          const downloadingCount = cached.items.filter((item) => item.download_status === "downloading").length;
          const errorCount = cached.items.filter((item) => item.download_status === "error").length;
          const dirtyCount = cached.items.filter((item) => item.sync_state === "dirty").length;
          const progress = cached.items.length ? Math.round(((cached.items.length - (cached.batch.counts.pending || 0)) / cached.items.length) * 100) : 0;
          return (
            <View key={cached.batch.uid} style={styles.batchCard}>
              <View style={styles.batchHeader}>
                <View style={styles.batchCopy}>
                  <Text style={styles.batchTitle}>{cached.batch.name}</Text>
                  <Text style={styles.batchMeta}>{cached.batch.uid}</Text>
                </View>
                <StatusChip
                  label={cached.batch.status}
                  tone={cached.batch.status === "completed" ? "ok" : cached.batch.status === "canceled" ? "warn" : "accent"}
                />
              </View>
              <Text style={styles.batchMeta}>Прогресс ревью: {progress}%</Text>
              <Text style={styles.batchMeta}>Оригиналов в кэше: {downloadedCount} / {cached.items.length}</Text>
              <Text style={styles.batchMeta}>Загрузка: {downloadingCount ? `в процессе ${downloadingCount}` : "очередь пуста"}{errorCount ? ` · ошибок ${errorCount}` : ""}</Text>
              <Text style={styles.batchMeta}>Unsynced решений: {dirtyCount}</Text>
              <Text style={styles.batchMeta}>Последний sync: {formatTime(cached.lastSyncedAt)}</Text>
              <Text style={styles.batchMeta}>{batchDecisionSummary(cached.batch)}</Text>
              <View style={styles.inlineButtons}>
                <AppButton label="Открыть" onPress={() => onOpenBatch(cached.batch.uid)} tone="primary" style={styles.inlineButton} />
                <AppButton
                  label={dirtyCount ? "Sync" : "Sync ok"}
                  onPress={() => void onSyncBatch(cached.batch.uid)}
                  style={styles.inlineButton}
                  disabled={Boolean(busy)}
                />
                <AppButton label="Обновить батч" onPress={() => void onDownloadBatch(cached.batch.uid)} style={styles.inlineButton} />
                {cached.batch.status !== "open" ? (
                  <AppButton label="Удалить батч" onPress={() => confirmRemove(cached.batch.uid)} style={styles.inlineButton} />
                ) : null}
              </View>
            </View>
          );
        })}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Батчи на сервере</Text>
        <Text style={styles.cardText}>
          Режимы просмотра: {(capabilities?.selection_modes || []).join(", ")}. Originals only: {String(capabilities?.supports_originals_only)}.
        </Text>
        {!visibleRemoteBatches.length ? <Text style={styles.cardText}>Под текущий фильтр серверных батчей ничего не осталось.</Text> : null}
        {visibleRemoteBatches.map((batch) => {
          const cached = localBatches[batch.uid];
          return (
            <View key={batch.uid} style={styles.batchCard}>
              <View style={styles.batchHeader}>
                <View style={styles.batchCopy}>
                  <Text style={styles.batchTitle}>{batch.name}</Text>
                  <Text style={styles.batchMeta}>{batch.selected_roots.join(", ") || "all incoming"}</Text>
                </View>
                <StatusChip label={batch.status} tone={batch.status === "completed" ? "ok" : batch.status === "canceled" ? "warn" : "accent"} />
              </View>
              <Text style={styles.batchMeta}>Прогресс телефона: {batch.cursor_index} / {batch.total_items}</Text>
              <Text style={styles.batchMeta}>{batchDecisionSummary(batch)}</Text>
              <View style={styles.inlineButtons}>
                <AppButton
                  label={cached ? "Открыть локально" : "Скачать на телефон"}
                  onPress={() => (cached ? onOpenBatch(batch.uid) : void onDownloadBatch(batch.uid))}
                  tone="primary"
                  style={styles.inlineButton}
                />
                {cached ? <AppButton label="Обновить" onPress={() => void onDownloadBatch(batch.uid)} style={styles.inlineButton} /> : null}
                {batch.status !== "open" ? (
                  <AppButton label="Удалить батч" onPress={() => confirmRemove(batch.uid)} style={styles.inlineButton} />
                ) : null}
              </View>
            </View>
          );
        })}
      </View>
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  actionsRow: {
    flexDirection: "row",
  },
  error: {
    color: theme.danger,
    fontSize: 14,
  },
  card: {
    backgroundColor: theme.panel,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: theme.border,
    padding: 16,
    gap: 12,
  },
  cardTitle: {
    color: theme.text,
    fontSize: 20,
    fontWeight: "800",
  },
  cardText: {
    color: theme.muted,
    fontSize: 14,
    lineHeight: 21,
  },
  summaryGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  summaryTile: {
    flexGrow: 1,
    minWidth: 132,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.panelSoft,
    padding: 12,
    gap: 4,
  },
  summaryValue: {
    color: theme.text,
    fontSize: 24,
    fontWeight: "800",
  },
  summaryLabel: {
    color: theme.muted,
    fontSize: 13,
  },
  resumeCard: {
    borderRadius: 20,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.accentSoft,
    padding: 14,
    gap: 10,
  },
  rootChips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  rootChip: {
    minWidth: 120,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: "#fffefb",
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 3,
  },
  rootChipSelected: {
    backgroundColor: theme.accentSoft,
    borderColor: "#b7d8db",
  },
  rootChipLabel: {
    color: theme.text,
    fontWeight: "700",
  },
  rootChipLabelSelected: {
    color: theme.accentStrong,
  },
  rootChipMeta: {
    color: theme.muted,
    fontSize: 12,
  },
  input: {
    minHeight: 50,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: "#ffffff",
    paddingHorizontal: 14,
    color: theme.text,
    fontSize: 16,
  },
  batchCard: {
    borderRadius: 20,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.panelSoft,
    padding: 14,
    gap: 8,
  },
  batchHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 12,
  },
  batchCopy: {
    flex: 1,
    gap: 4,
  },
  batchTitle: {
    color: theme.text,
    fontSize: 17,
    fontWeight: "800",
  },
  batchMeta: {
    color: theme.muted,
    fontSize: 13,
    lineHeight: 18,
  },
  inlineButtons: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  inlineButton: {
    flex: 1,
    minWidth: 90,
  },
  scopeRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  scopeButton: {
    minWidth: 96,
  },
});
