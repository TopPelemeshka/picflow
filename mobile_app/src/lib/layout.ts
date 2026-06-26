import type { CachedBatchItem } from "../types";

export type GridRow =
  | { kind: "full"; item: CachedBatchItem }
  | { kind: "pair"; left: CachedBatchItem; right: CachedBatchItem | null };

function isLandscape(item: CachedBatchItem): boolean {
  return item.width >= item.height;
}

export function buildGridRows(items: CachedBatchItem[]): GridRow[] {
  const rows: GridRow[] = [];
  let pendingVertical: CachedBatchItem | null = null;
  for (const item of items) {
    if (isLandscape(item)) {
      if (pendingVertical) {
        rows.push({ kind: "pair", left: pendingVertical, right: null });
        pendingVertical = null;
      }
      rows.push({ kind: "full", item });
      continue;
    }
    if (!pendingVertical) {
      pendingVertical = item;
      continue;
    }
    rows.push({ kind: "pair", left: pendingVertical, right: item });
    pendingVertical = null;
  }
  if (pendingVertical) {
    rows.push({ kind: "pair", left: pendingVertical, right: null });
  }
  return rows;
}
