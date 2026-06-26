import { useEffect, useRef, useState } from "react";

import {
  absoluteMediaUrl,
  createBatch as apiCreateBatch,
  deleteBatch as apiDeleteBatch,
  fetchBatch,
  fetchBatchItems,
  fetchBatches,
  fetchCapabilities,
  fetchRoots,
  pairDevice,
  syncBatch as apiSyncBatch,
} from "../lib/api";
import { downloadOriginalToCache, ensureCacheReady, removeBatchCacheDir } from "../lib/cache";
import {
  clearSession,
  loadActiveBatchUid,
  loadBatches,
  loadConnectionDraft,
  loadSession,
  saveActiveBatchUid,
  saveBatches,
  saveConnectionDraft,
  saveSession,
} from "../lib/storage";
import type {
  BatchCounts,
  BatchDecision,
  CachedBatch,
  CachedBatchItem,
  CachedSession,
  ConnectionDraft,
  MobileRoot,
  RemoteBatch,
  RemoteCapabilities,
  ReviewMode,
} from "../types";

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeServerUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  return trimmed.startsWith("http://") || trimmed.startsWith("https://") ? trimmed : `http://${trimmed}`;
}

function computeCounts(items: CachedBatchItem[]): BatchCounts {
  const counts: BatchCounts = { total: items.length, pending: 0, good: 0, bad: 0, purge: 0 };
  for (const item of items) {
    if (item.decision === "good") counts.good = (counts.good || 0) + 1;
    else if (item.decision === "bad") counts.bad = (counts.bad || 0) + 1;
    else if (item.decision === "purge") counts.purge = (counts.purge || 0) + 1;
    else counts.pending = (counts.pending || 0) + 1;
  }
  return counts;
}

function patchItemDownloadState(
  current: Record<string, CachedBatch>,
  batchUid: string,
  itemId: number,
  patch: Partial<CachedBatchItem>,
): Record<string, CachedBatch> {
  const cachedBatch = current[batchUid];
  if (!cachedBatch) {
    return current;
  }
  return {
    ...current,
    [batchUid]: {
      ...cachedBatch,
      items: cachedBatch.items.map((candidate) => (candidate.id === itemId ? { ...candidate, ...patch } : candidate)),
      localUpdatedAt: nowIso(),
    },
  };
}

function orderDownloadQueue(items: CachedBatchItem[], priorityIndex: number): CachedBatchItem[] {
  return [...items].sort((left, right) => {
    const leftDistance = Math.abs(left.position - priorityIndex);
    const rightDistance = Math.abs(right.position - priorityIndex);
    if (leftDistance !== rightDistance) {
      return leftDistance - rightDistance;
    }
    return left.position - right.position;
  });
}

function hasPendingDownloads(cachedBatch: CachedBatch | undefined): boolean {
  if (!cachedBatch) {
    return false;
  }
  return cachedBatch.items.some((item) => item.remote_original_url && !item.local_uri && item.download_status !== "done");
}

function mergeItem(session: CachedSession, incoming: CachedBatchItem, previous?: CachedBatchItem): CachedBatchItem {
  const remoteUrl = absoluteMediaUrl(session.serverUrl, incoming.original_url);
  const shouldKeepLocalDecision =
    previous &&
    previous.sync_state === "dirty" &&
    previous.client_updated_at &&
    (!incoming.client_updated_at || new Date(previous.client_updated_at).getTime() >= new Date(incoming.client_updated_at).getTime());

  return {
    ...incoming,
    decision: shouldKeepLocalDecision ? previous.decision : incoming.decision,
    client_updated_at: shouldKeepLocalDecision ? previous.client_updated_at : incoming.client_updated_at,
    local_uri: previous?.local_uri ?? null,
    remote_original_url: remoteUrl,
    download_status: previous?.download_status ?? "pending",
    last_error: previous?.last_error ?? null,
    sync_state: shouldKeepLocalDecision ? "dirty" : "clean",
  };
}

export function useAppModel() {
  const [booting, setBooting] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<CachedSession | null>(null);
  const [connectionDraft, setConnectionDraft] = useState<ConnectionDraft>({
    serverUrl: "http://192.168.0.10:8765",
    deviceName: "My phone",
  });
  const [capabilities, setCapabilities] = useState<RemoteCapabilities | null>(null);
  const [roots, setRoots] = useState<MobileRoot[]>([]);
  const [remoteBatches, setRemoteBatches] = useState<RemoteBatch[]>([]);
  const [localBatches, setLocalBatches] = useState<Record<string, CachedBatch>>({});
  const [activeBatchUid, setActiveBatchUid] = useState<string | null>(null);
  const [reviewMode, setReviewMode] = useState<ReviewMode>("single");
  const downloadJobs = useRef<Set<string>>(new Set());
  const downloadPriority = useRef<Record<string, number>>({});

  useEffect(() => {
    async function bootstrap() {
      try {
        await ensureCacheReady();
        const [loadedSession, loadedBatches, loadedActiveBatchUid, loadedConnectionDraft] = await Promise.all([
          loadSession(),
          loadBatches(),
          loadActiveBatchUid(),
          loadConnectionDraft(),
        ]);
        setSession(loadedSession);
        setLocalBatches(loadedBatches);
        setActiveBatchUid(loadedActiveBatchUid);
        setConnectionDraft(loadedConnectionDraft);
        if (loadedSession) {
          void queuePendingDownloads(loadedSession, loadedBatches);
          await refreshAll(loadedSession, loadedBatches);
        }
      } catch (bootstrapError) {
        setError(bootstrapError instanceof Error ? bootstrapError.message : "Не удалось загрузить приложение");
      } finally {
        setBooting(false);
      }
    }
    void bootstrap();
  }, []);

  useEffect(() => {
    if (booting) {
      return;
    }
    void saveBatches(localBatches);
  }, [localBatches, booting]);

  useEffect(() => {
    if (booting) {
      return;
    }
    void saveActiveBatchUid(activeBatchUid);
  }, [activeBatchUid, booting]);

  async function refreshAll(currentSession = session, knownLocalBatches = localBatches) {
    if (!currentSession) {
      return;
    }
    const [nextCapabilities, nextRoots, nextRemoteBatches] = await Promise.all([
      fetchCapabilities(currentSession.serverUrl, currentSession.accessToken),
      fetchRoots(currentSession.serverUrl, currentSession.accessToken),
      fetchBatches(currentSession.serverUrl, currentSession.accessToken),
    ]);
    setCapabilities(nextCapabilities);
    setRoots(nextRoots);
    setRemoteBatches(nextRemoteBatches);

    const patch: Record<string, CachedBatch> = { ...knownLocalBatches };
    for (const batch of nextRemoteBatches) {
      if (patch[batch.uid]) {
        patch[batch.uid] = {
          ...patch[batch.uid],
          batch: {
            ...patch[batch.uid].batch,
            ...batch,
          },
        };
      }
    }
    setLocalBatches(patch);
  }

  async function removeBatch(batchUid: string) {
    setBusy("Удаление батча");
    setError(null);
    try {
      const cachedBatch = localBatches[batchUid];
      const remoteBatch = remoteBatches.find((item) => item.uid === batchUid);
      if (session && (remoteBatch || cachedBatch?.batch.status === "open")) {
        await apiDeleteBatch(session.serverUrl, session.accessToken, batchUid);
      }
      downloadJobs.current.delete(batchUid);
      delete downloadPriority.current[batchUid];
      await removeBatchCacheDir(batchUid);
      setLocalBatches((current) => {
        const next = { ...current };
        delete next[batchUid];
        return next;
      });
      setRemoteBatches((current) => current.filter((item) => item.uid !== batchUid));
      setActiveBatchUid((current) => (current === batchUid ? null : current));
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : "Не удалось удалить батч");
      throw removeError;
    } finally {
      setBusy(null);
    }
  }

  async function connect(serverUrlRaw: string, code: string, deviceName: string) {
    setBusy("Подключение");
    setError(null);
    try {
      const serverUrl = normalizeServerUrl(serverUrlRaw);
      const paired = await pairDevice(serverUrl, code, deviceName);
      const nextSession: CachedSession = {
        serverUrl,
        accessToken: paired.access_token,
        deviceId: paired.device.id,
        deviceName: paired.device.device_name,
        pairedAt: nowIso(),
      };
      const nextDraft = {
        serverUrl,
        deviceName: paired.device.device_name,
      };
      await saveSession(nextSession);
      await saveConnectionDraft(nextDraft);
      setSession(nextSession);
      setConnectionDraft(nextDraft);
      void queuePendingDownloads(nextSession, localBatches);
      await refreshAll(nextSession, localBatches);
    } catch (connectError) {
      setError(connectError instanceof Error ? connectError.message : "Ошибка подключения");
      throw connectError;
    } finally {
      setBusy(null);
    }
  }

  async function disconnect() {
    setBusy("Отключение");
    try {
      await clearSession();
      setSession(null);
      setCapabilities(null);
      setRoots([]);
      setRemoteBatches([]);
      setActiveBatchUid(null);
    } finally {
      setBusy(null);
    }
  }

  async function createBatch(rootNames: string[], batchSize: number, name?: string) {
    if (!session) {
      return;
    }
    setBusy("Создание батча");
    setError(null);
    try {
      const batch = await apiCreateBatch(session.serverUrl, session.accessToken, rootNames, batchSize, name);
      setRemoteBatches((current) => [batch, ...current.filter((item) => item.uid !== batch.uid)]);
      await downloadBatch(batch.uid);
      setActiveBatchUid(batch.uid);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Не удалось создать батч");
      throw createError;
    } finally {
      setBusy(null);
    }
  }

  async function downloadBatch(batchUid: string) {
    if (!session) {
      return;
    }
    if (downloadJobs.current.has(batchUid)) {
      return;
    }
    setBusy("Скачивание батча");
    downloadJobs.current.add(batchUid);
    try {
      const [batch, itemsPayload] = await Promise.all([
        fetchBatch(session.serverUrl, session.accessToken, batchUid),
        fetchBatchItems(session.serverUrl, session.accessToken, batchUid),
      ]);
      const previous = localBatches[batchUid];
      const previousMap = new Map(previous?.items.map((item) => [item.id, item]) ?? []);
      const nextItems: CachedBatchItem[] = itemsPayload.items.map((item) =>
        mergeItem(session, item as CachedBatchItem, previousMap.get(item.id)),
      );
      const nextCounts = computeCounts(nextItems);
      const nextCachedBatch: CachedBatch = {
        batch: {
          ...batch,
          counts: nextCounts,
        },
        items: nextItems,
        localUpdatedAt: nowIso(),
        lastSyncedAt: previous?.lastSyncedAt ?? null,
        serverUrl: session.serverUrl,
        deviceId: session.deviceId,
      };
      downloadPriority.current[batchUid] = nextCachedBatch.batch.cursor_index;
      setLocalBatches((current) => ({
        ...current,
        [batchUid]: nextCachedBatch,
      }));
      setActiveBatchUid(batchUid);
      void downloadMissingImages(batchUid, nextItems, session, nextCachedBatch.batch.cursor_index);
      await refreshAll(session, {
        ...localBatches,
        [batchUid]: nextCachedBatch,
      });
    } catch (downloadError) {
      downloadJobs.current.delete(batchUid);
      setError(downloadError instanceof Error ? downloadError.message : "Не удалось скачать батч");
      throw downloadError;
    } finally {
      setBusy(null);
    }
  }

  async function downloadMissingImages(
    batchUid: string,
    items: CachedBatchItem[],
    currentSession: CachedSession,
    priorityIndex: number,
  ) {
    let remaining = items.filter((item) => item.remote_original_url && !item.local_uri && item.download_status !== "done");
    downloadPriority.current[batchUid] = priorityIndex;
    while (remaining.length) {
      const nextPriority = downloadPriority.current[batchUid] ?? priorityIndex;
      const [item, ...rest] = orderDownloadQueue(remaining, nextPriority);
      remaining = rest;
      if (!item.remote_original_url || item.local_uri || item.download_status === "done") {
        continue;
      }
      try {
        setLocalBatches((current) =>
          patchItemDownloadState(current, batchUid, item.id, {
            download_status: "downloading",
            last_error: null,
          }),
        );
        const localUri = await downloadOriginalToCache(
          batchUid,
          item.id,
          item.file_name,
          item.remote_original_url,
          currentSession.accessToken,
          item.size_bytes,
        );
        setLocalBatches((current) =>
          patchItemDownloadState(current, batchUid, item.id, {
            local_uri: localUri,
            download_status: "done",
            last_error: null,
          }),
        );
      } catch (downloadError) {
        setLocalBatches((current) =>
          patchItemDownloadState(current, batchUid, item.id, {
            download_status: "error",
            last_error: downloadError instanceof Error ? downloadError.message : "Ошибка загрузки",
          }),
        );
      }
    }
    downloadJobs.current.delete(batchUid);
  }

  async function queuePendingDownloads(currentSession: CachedSession, knownBatches: Record<string, CachedBatch>) {
    for (const [batchUid, cachedBatch] of Object.entries(knownBatches)) {
      if (cachedBatch.serverUrl && cachedBatch.serverUrl !== currentSession.serverUrl) {
        continue;
      }
      if (downloadJobs.current.has(batchUid)) {
        continue;
      }
      const hasPending = hasPendingDownloads(cachedBatch);
      if (!hasPending) {
        continue;
      }
      downloadJobs.current.add(batchUid);
      downloadPriority.current[batchUid] = cachedBatch.batch.cursor_index;
      void downloadMissingImages(batchUid, cachedBatch.items, currentSession, cachedBatch.batch.cursor_index);
    }
  }

  function setDecision(batchUid: string, itemId: number, decision: BatchDecision) {
    setLocalBatches((current) => {
      const cachedBatch = current[batchUid];
      if (!cachedBatch) {
        return current;
      }
      const nextItems = cachedBatch.items.map((item) =>
        item.id === itemId
          ? {
              ...item,
              decision,
              client_updated_at: nowIso(),
              sync_state: "dirty" as const,
            }
          : item,
      );
      return {
        ...current,
        [batchUid]: {
          ...cachedBatch,
          batch: {
            ...cachedBatch.batch,
            counts: computeCounts(nextItems),
          },
          items: nextItems,
          localUpdatedAt: nowIso(),
        },
      };
    });
  }

  function setBatchCursor(batchUid: string, cursorIndex: number) {
    downloadPriority.current[batchUid] = cursorIndex;
    setLocalBatches((current) => {
      const cachedBatch = current[batchUid];
      if (!cachedBatch) {
        return current;
      }
      return {
        ...current,
        [batchUid]: {
          ...cachedBatch,
          batch: {
            ...cachedBatch.batch,
            cursor_index: cursorIndex,
          },
          localUpdatedAt: nowIso(),
        },
      };
    });
    if (session && !downloadJobs.current.has(batchUid) && hasPendingDownloads(localBatches[batchUid])) {
      downloadJobs.current.add(batchUid);
      void downloadMissingImages(batchUid, localBatches[batchUid].items, session, cursorIndex);
    }
  }

  async function syncActiveBatch() {
    if (!activeBatchUid) {
      return;
    }
    await syncBatch(activeBatchUid);
  }

  async function syncBatch(batchUid: string) {
    if (!session) {
      return;
    }
    const cachedBatch = localBatches[batchUid];
    if (!cachedBatch) {
      return;
    }
    const updates = cachedBatch.items
      .filter((item) => item.sync_state === "dirty")
      .map((item) => ({
        item_id: item.id,
        decision: (item.decision ?? "clear") as "good" | "bad" | "purge" | "clear",
        client_updated_at: item.client_updated_at ?? nowIso(),
      }));
    if (!updates.length) {
      await refreshAll();
      return;
    }
    setBusy("Синхронизация");
    setError(null);
    try {
      const syncedBatch = await apiSyncBatch(
        session.serverUrl,
        session.accessToken,
        batchUid,
        cachedBatch.batch.cursor_index,
        updates,
      );
      setLocalBatches((current) => {
        const live = current[batchUid];
        if (!live) {
          return current;
        }
        return {
          ...current,
          [batchUid]: {
            ...live,
            batch: {
              ...live.batch,
              ...syncedBatch,
            },
            items: live.items.map((item) =>
              item.sync_state === "dirty"
                ? {
                    ...item,
                    sync_state: "clean",
                  }
                : item,
            ),
            localUpdatedAt: nowIso(),
            lastSyncedAt: nowIso(),
          },
        };
      });
      await refreshAll();
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : "Ошибка синхронизации");
      throw syncError;
    } finally {
      setBusy(null);
    }
  }

  async function refreshActiveBatch() {
    if (!activeBatchUid) {
      return;
    }
    await downloadBatch(activeBatchUid);
  }

  const sessionLocalBatches = Object.fromEntries(
    Object.entries(localBatches).filter(([, batch]) => !session || !batch.serverUrl || batch.serverUrl === session.serverUrl),
  );
  const activeBatch = activeBatchUid ? sessionLocalBatches[activeBatchUid] ?? null : null;

  return {
    booting,
    busy,
    error,
    session,
    connectionDraft,
    capabilities,
    roots,
    remoteBatches,
    localBatches: sessionLocalBatches,
    activeBatchUid,
    activeBatch,
    reviewMode,
    connect,
    disconnect,
    refreshAll: () => refreshAll(),
    createBatch,
    downloadBatch,
    removeBatch,
    syncBatch,
    setActiveBatchUid,
    setDecision,
    setBatchCursor,
    syncActiveBatch,
    refreshActiveBatch,
    setReviewMode,
  };
}
