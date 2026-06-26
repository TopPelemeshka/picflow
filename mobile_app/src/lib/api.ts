import type {
  BatchUpdatePayload,
  MobileRoot,
  PairingResult,
  RemoteBatch,
  RemoteBatchItem,
  RemoteCapabilities,
} from "../types";

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "error" in payload ? String(payload.error) : response.statusText;
    throw new Error(message || "Request failed");
  }
  return payload as T;
}

function authHeaders(token: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

export async function pairDevice(serverUrl: string, code: string, deviceName: string): Promise<PairingResult> {
  return request<PairingResult>(joinUrl(serverUrl, "/api/mobile/pair"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, device_name: deviceName }),
  });
}

export async function fetchCapabilities(serverUrl: string, token: string): Promise<RemoteCapabilities> {
  return request<RemoteCapabilities>(joinUrl(serverUrl, "/api/mobile/capabilities"), {
    headers: authHeaders(token),
  });
}

export async function fetchRoots(serverUrl: string, token: string): Promise<MobileRoot[]> {
  const payload = await request<{ roots: MobileRoot[] }>(joinUrl(serverUrl, "/api/mobile/roots"), {
    headers: authHeaders(token),
  });
  return payload.roots;
}

export async function fetchBatches(serverUrl: string, token: string): Promise<RemoteBatch[]> {
  const payload = await request<{ items: RemoteBatch[] }>(joinUrl(serverUrl, "/api/mobile/batches"), {
    headers: authHeaders(token),
  });
  return payload.items;
}

export async function createBatch(
  serverUrl: string,
  token: string,
  rootNames: string[],
  batchSize: number,
  name?: string,
): Promise<RemoteBatch> {
  return request<RemoteBatch>(joinUrl(serverUrl, "/api/mobile/batches"), {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({
      root_names: rootNames,
      batch_size: batchSize,
      name,
    }),
  });
}

export async function fetchBatch(serverUrl: string, token: string, batchUid: string): Promise<RemoteBatch> {
  return request<RemoteBatch>(joinUrl(serverUrl, `/api/mobile/batches/${encodeURIComponent(batchUid)}`), {
    headers: authHeaders(token),
  });
}

export async function fetchBatchItems(
  serverUrl: string,
  token: string,
  batchUid: string,
): Promise<{ batch: RemoteBatch; items: RemoteBatchItem[] }> {
  const pageSize = 500;
  let offset = 0;
  const items: RemoteBatchItem[] = [];

  for (;;) {
    const payload = await request<{ batch: RemoteBatch; items: RemoteBatchItem[] }>(
      joinUrl(serverUrl, `/api/mobile/batches/${encodeURIComponent(batchUid)}/items?limit=${pageSize}&offset=${offset}`),
      {
        headers: authHeaders(token),
      },
    );
    items.push(...payload.items);
    if (payload.items.length < pageSize || items.length >= payload.batch.total_items) {
      return { batch: payload.batch, items };
    }
    offset += payload.items.length;
  }
}

export async function syncBatch(
  serverUrl: string,
  token: string,
  batchUid: string,
  cursorIndex: number,
  updates: BatchUpdatePayload[],
): Promise<RemoteBatch> {
  const payload = await request<{ batch: RemoteBatch }>(
    joinUrl(serverUrl, `/api/mobile/batches/${encodeURIComponent(batchUid)}/sync`),
    {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        cursor_index: cursorIndex,
        updates,
      }),
    },
  );
  return payload.batch;
}

export async function deleteBatch(serverUrl: string, token: string, batchUid: string): Promise<{ deleted: boolean; batch: RemoteBatch }> {
  return request<{ deleted: boolean; batch: RemoteBatch }>(
    joinUrl(serverUrl, `/api/mobile/batches/${encodeURIComponent(batchUid)}/delete`),
    {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({}),
    },
  );
}

export function absoluteMediaUrl(serverUrl: string, relativeUrl: string | null): string | null {
  if (!relativeUrl) {
    return null;
  }
  return joinUrl(serverUrl, relativeUrl);
}
