export type PairingResult = {
  access_token: string;
  device: {
    id: number;
    device_name: string;
    created_at: string;
  };
};

export type MobileRoot = {
  root_name: string;
  total: number;
  reserved: number;
  available: number;
};

export type BatchCounts = {
  total?: number;
  pending?: number;
  good?: number;
  bad?: number;
  purge?: number;
  skipped?: number;
};

export type RemoteBatch = {
  id: number;
  uid: string;
  device_id: number;
  device_name?: string;
  name: string;
  status: "open" | "completed" | "canceled";
  selected_roots: string[];
  total_items: number;
  cursor_index: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  available_originals?: number;
  counts: BatchCounts;
};

export type RemoteBatchItem = {
  id: number;
  image_id: number | null;
  position: number;
  decision: BatchDecision;
  client_updated_at: string | null;
  decision_updated_at: string | null;
  applied_action: string | null;
  applied_at: string | null;
  root_name: string;
  file_name: string;
  width: number;
  height: number;
  size_bytes: number;
  is_available: boolean;
  original_url: string | null;
};

export type RemoteCapabilities = {
  selection_modes: string[];
  supports_originals_only: boolean;
  supports_partial_sync: boolean;
  supports_purge: boolean;
  approved_dir: string;
  rejected_dir: string;
  device: {
    id: number;
    device_name: string;
  };
};

export type BatchDecision = "good" | "bad" | "purge" | null;

export type CachedSession = {
  serverUrl: string;
  accessToken: string;
  deviceId: number;
  deviceName: string;
  pairedAt: string;
};

export type ConnectionDraft = {
  serverUrl: string;
  deviceName: string;
};

export type CachedBatchItem = RemoteBatchItem & {
  local_uri: string | null;
  remote_original_url: string | null;
  download_status: "pending" | "downloading" | "done" | "error";
  last_error: string | null;
  sync_state: "clean" | "dirty";
};

export type CachedBatch = {
  batch: RemoteBatch;
  items: CachedBatchItem[];
  localUpdatedAt: string;
  lastSyncedAt: string | null;
  serverUrl: string;
  deviceId: number;
};

export type BatchUpdatePayload = {
  item_id: number;
  decision: "good" | "bad" | "purge" | "clear";
  client_updated_at: string;
};

export type ReviewMode = "single" | "feed" | "grid";

export type ReviewFilter = "all" | "pending" | "reviewed" | "purge";
