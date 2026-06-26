import AsyncStorage from "@react-native-async-storage/async-storage";

import type { CachedBatch, CachedSession, ConnectionDraft } from "../types";

const SESSION_KEY = "picflow_mobile_session";
const BATCHES_KEY = "picflow_mobile_batches";
const ACTIVE_BATCH_KEY = "picflow_mobile_active_batch_uid";
const CONNECTION_DRAFT_KEY = "picflow_mobile_connection_draft";

function defaultConnectionDraft(): ConnectionDraft {
  return {
    serverUrl: "http://192.168.0.10:8765",
    deviceName: "My phone",
  };
}

async function loadJsonValue<T>(key: string, fallback: T): Promise<T> {
  const raw = await AsyncStorage.getItem(key);
  if (!raw) {
    return fallback;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    await AsyncStorage.removeItem(key);
    return fallback;
  }
}

export async function loadSession(): Promise<CachedSession | null> {
  return loadJsonValue<CachedSession | null>(SESSION_KEY, null);
}

export async function saveSession(session: CachedSession): Promise<void> {
  await AsyncStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export async function clearSession(): Promise<void> {
  await AsyncStorage.removeItem(SESSION_KEY);
}

export async function loadBatches(): Promise<Record<string, CachedBatch>> {
  return loadJsonValue<Record<string, CachedBatch>>(BATCHES_KEY, {});
}

export async function saveBatches(batches: Record<string, CachedBatch>): Promise<void> {
  await AsyncStorage.setItem(BATCHES_KEY, JSON.stringify(batches));
}

export async function loadActiveBatchUid(): Promise<string | null> {
  return AsyncStorage.getItem(ACTIVE_BATCH_KEY);
}

export async function saveActiveBatchUid(batchUid: string | null): Promise<void> {
  if (!batchUid) {
    await AsyncStorage.removeItem(ACTIVE_BATCH_KEY);
    return;
  }
  await AsyncStorage.setItem(ACTIVE_BATCH_KEY, batchUid);
}

export async function loadConnectionDraft(): Promise<ConnectionDraft> {
  return loadJsonValue<ConnectionDraft>(CONNECTION_DRAFT_KEY, defaultConnectionDraft());
}

export async function saveConnectionDraft(draft: ConnectionDraft): Promise<void> {
  await AsyncStorage.setItem(CONNECTION_DRAFT_KEY, JSON.stringify(draft));
}
