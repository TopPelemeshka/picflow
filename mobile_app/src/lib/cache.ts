import * as FileSystem from "expo-file-system";

function getRootDir(): string {
  const baseDir = FileSystem.documentDirectory;
  if (!baseDir) {
    throw new Error("Локальное файловое хранилище недоступно на этом устройстве");
  }
  return `${baseDir}picflow`;
}

async function ensureDir(path: string): Promise<void> {
  const info = await FileSystem.getInfoAsync(path);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(path, { intermediates: true });
  }
}

function sanitizeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function getFileSize(info: FileSystem.FileInfo): number | null {
  return "size" in info && typeof info.size === "number" ? info.size : null;
}

export async function ensureCacheReady(): Promise<void> {
  const rootDir = getRootDir();
  await ensureDir(rootDir);
  await ensureDir(`${rootDir}/batches`);
}

export async function getBatchCacheDir(batchUid: string): Promise<string> {
  const rootDir = getRootDir();
  await ensureCacheReady();
  const target = `${rootDir}/batches/${sanitizeFileName(batchUid)}`;
  await ensureDir(target);
  return target;
}

export async function removeBatchCacheDir(batchUid: string): Promise<void> {
  const rootDir = getRootDir();
  const target = `${rootDir}/batches/${sanitizeFileName(batchUid)}`;
  await FileSystem.deleteAsync(target, { idempotent: true });
}

export async function downloadOriginalToCache(
  batchUid: string,
  itemId: number,
  fileName: string,
  remoteUrl: string,
  accessToken: string,
  expectedSizeBytes: number,
): Promise<string> {
  const dir = await getBatchCacheDir(batchUid);
  const target = `${dir}/${itemId}_${sanitizeFileName(fileName)}`;
  const info = await FileSystem.getInfoAsync(target);
  if (info.exists) {
    const currentSize = getFileSize(info);
    if (!expectedSizeBytes || currentSize === expectedSizeBytes) {
      return target;
    }
    await FileSystem.deleteAsync(target, { idempotent: true });
  }

  const response = await FileSystem.downloadAsync(remoteUrl, target, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (response.status !== 200) {
    await FileSystem.deleteAsync(target, { idempotent: true });
    throw new Error(`Не удалось скачать оригинал (${response.status})`);
  }

  const downloaded = await FileSystem.getInfoAsync(target);
  const downloadedSize = getFileSize(downloaded);
  if (expectedSizeBytes > 0 && downloadedSize !== expectedSizeBytes) {
    await FileSystem.deleteAsync(target, { idempotent: true });
    throw new Error("Скачан неполный или неверный файл");
  }
  return target;
}
