import { useEffect, useRef, useState } from "react";
import type { GestureResponderEvent } from "react-native";
import {
  Alert,
  BackHandler,
  FlatList,
  Image,
  PanResponder,
  Platform,
  Pressable,
  SafeAreaView,
  StatusBar as NativeStatusBar,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { StatusBar } from "expo-status-bar";

import { buildGridRows } from "../lib/layout";
import type { GridRow } from "../lib/layout";
import { theme } from "../lib/theme";
import type { BatchDecision, CachedBatch, CachedBatchItem, ReviewMode } from "../types";

type Props = {
  batch: CachedBatch;
  busy: string | null;
  error: string | null;
  reviewMode: ReviewMode;
  onChangeReviewMode: (mode: ReviewMode) => void;
  onBack: () => void;
  onRefresh: () => Promise<void>;
  onSync: () => Promise<void>;
  onSetDecision: (batchUid: string, itemId: number, decision: BatchDecision) => void;
  onSetCursor: (batchUid: string, cursorIndex: number) => void;
};

function resolveItemUri(item: CachedBatchItem): string | null {
  return item.local_uri;
}

function decisionLabel(decision: BatchDecision): string {
  if (decision === "good") return "Лайк";
  if (decision === "purge") return "Удалить";
  return "Без отметки";
}

function browserStatus(item: CachedBatchItem): string {
  if (item.decision === "purge") {
    return "Удалить";
  }
  if (item.download_status === "error") {
    return "Ошибка";
  }
  return `${item.position + 1}`;
}

function itemAspectRatio(item: CachedBatchItem): number {
  if (item.width > 0 && item.height > 0) {
    return item.width / item.height;
  }
  return 1;
}

function ItemImage({
  item,
  immersive = false,
  onRetry,
}: {
  item: CachedBatchItem;
  immersive?: boolean;
  onRetry?: (() => void) | null;
}) {
  const uri = resolveItemUri(item);
  const aspectRatio = itemAspectRatio(item);
  if (!uri) {
    const message =
      item.download_status === "error"
        ? item.last_error || "Не удалось скачать оригинал"
        : item.download_status === "downloading"
          ? "Оригинал загружается"
          : "Фото еще не скачано";
    return (
      <View
        style={[
          styles.placeholder,
          immersive ? styles.viewerPlaceholder : styles.previewPlaceholder,
          !immersive ? { aspectRatio } : null,
        ]}
      >
        <Text style={styles.placeholderTitle}>{message}</Text>
        <Text style={styles.placeholderHint}>Фото появится автоматически. Батч можно закрыть и продолжить позже.</Text>
        {onRetry ? (
          <Pressable onPress={onRetry} style={styles.retryButton}>
            <Text style={styles.retryButtonText}>Повторить</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }
  return (
    <Image
      resizeMode="contain"
      source={{ uri }}
      style={immersive ? styles.viewerImage : [styles.previewImage, { aspectRatio }]}
    />
  );
}

export function ReviewScreen({
  batch,
  busy,
  error,
  reviewMode,
  onChangeReviewMode,
  onBack,
  onRefresh,
  onSync,
  onSetDecision,
  onSetCursor,
}: Props) {
  const { width: viewportWidth } = useWindowDimensions();
  const [index, setIndex] = useState(Math.min(batch.batch.cursor_index, Math.max(0, batch.items.length - 1)));
  const [showDetails, setShowDetails] = useState(false);
  const [returnMode, setReturnMode] = useState<ReviewMode | null>(null);
  const [downloadBannerDismissed, setDownloadBannerDismissed] = useState(false);
  const browserOffsetsRef = useRef<{ feed: number; grid: number }>({ feed: 0, grid: 0 });
  const feedListRef = useRef<FlatList<CachedBatchItem> | null>(null);
  const gridListRef = useRef<FlatList<GridRow> | null>(null);
  const pendingRestoreRef = useRef<{ mode: ReviewMode; offset: number; anchorIndex?: number; anchorInset?: number } | null>(null);
  const lastBatchUidRef = useRef(batch.batch.uid);
  const lastItemsLengthRef = useRef(batch.items.length);

  const currentItem = batch.items[index] ?? null;
  const gridRows = buildGridRows(batch.items);
  const cachedCount = batch.items.filter((item) => item.local_uri).length;
  const downloadingCount = batch.items.filter((item) => item.download_status === "downloading").length;
  const pendingDownloadCount = batch.items.filter((item) => item.remote_original_url && !item.local_uri).length;
  const errorDownloadCount = batch.items.filter((item) => item.download_status === "error").length;
  const dirtyCount = batch.items.filter((item) => item.sync_state === "dirty").length;
  const syncBusy = busy === "Синхронизация";
  const feedItemLengths: number[] = [];
  const feedItemOffsets: number[] = [];
  let feedRunningOffset = 0;
  for (const item of batch.items) {
    feedItemOffsets.push(feedRunningOffset);
    const length = Math.max(1, viewportWidth / itemAspectRatio(item)) + 6;
    feedItemLengths.push(length);
    feedRunningOffset += length;
  }

  useEffect(() => {
    const nextIndex = Math.min(batch.batch.cursor_index, Math.max(0, batch.items.length - 1));
    const batchChanged = lastBatchUidRef.current !== batch.batch.uid;
    const itemsLengthChanged = lastItemsLengthRef.current !== batch.items.length;

    setIndex(nextIndex);

    if (batchChanged || itemsLengthChanged) {
      setShowDetails(false);
      setReturnMode(null);
      setDownloadBannerDismissed(false);
      lastBatchUidRef.current = batch.batch.uid;
      lastItemsLengthRef.current = batch.items.length;
    }
  }, [batch.batch.cursor_index, batch.batch.uid, batch.items.length]);

  useEffect(() => {
    if (!pendingDownloadCount) {
      setDownloadBannerDismissed(false);
    }
  }, [pendingDownloadCount]);

  useEffect(() => {
    const pendingRestore = pendingRestoreRef.current;
    if (!pendingRestore || pendingRestore.mode !== reviewMode || reviewMode === "single") {
      return;
    }

    const restore = () => {
      const targetRef = pendingRestore.mode === "feed" ? feedListRef.current : gridListRef.current;
      if (!targetRef) {
        return;
      }
      if (pendingRestore.mode === "feed" && pendingRestore.anchorIndex !== undefined) {
        feedListRef.current?.scrollToIndex({
          animated: false,
          index: pendingRestore.anchorIndex,
          viewOffset: Math.max(0, pendingRestore.anchorInset ?? 0),
        });
      } else {
        targetRef.scrollToOffset({
          animated: false,
          offset: pendingRestore.offset,
        });
      }
      pendingRestoreRef.current = null;
    };

    requestAnimationFrame(() => {
      requestAnimationFrame(restore);
    });
  }, [reviewMode]);

  function move(nextIndex: number) {
    const clamped = Math.min(Math.max(nextIndex, 0), Math.max(0, batch.items.length - 1));
    setIndex(clamped);
    onSetCursor(batch.batch.uid, clamped);
    setShowDetails(false);
  }

  function handleBackNavigation(): boolean {
    if (showDetails) {
      setShowDetails(false);
      return true;
    }
    if (reviewMode === "single" && returnMode && returnMode !== "single") {
      const nextMode = returnMode;
      const nextRestore =
        nextMode === "feed"
          ? {
              mode: nextMode,
              offset: browserOffsetsRef.current[nextMode],
              anchorIndex: index,
              anchorInset: Math.max(0, (feedItemOffsets[index] ?? 0) - browserOffsetsRef.current.feed),
            }
          : {
              mode: nextMode,
              offset: browserOffsetsRef.current[nextMode],
            };
      pendingRestoreRef.current = {
        ...nextRestore,
      };
      setReturnMode(null);
      onChangeReviewMode(nextMode);
      return true;
    }
    onBack();
    return true;
  }

  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", handleBackNavigation);
    return () => subscription.remove();
  });

  function openItem(item: CachedBatchItem, sourceMode: ReviewMode) {
    setReturnMode(sourceMode);
    move(item.position);
    onChangeReviewMode("single");
  }

  function commitDecision(item: CachedBatchItem, decision: BatchDecision, advance = false) {
    const apply = () => {
      onSetDecision(batch.batch.uid, item.id, decision);
      if (advance && index < batch.items.length - 1) {
        move(index + 1);
      }
    };
    if (decision === "purge") {
      Alert.alert(
        "Пометить на полное удаление?",
        "Файл не удаляется мгновенно, но после синхронизации попадет в purge-очередь. Это опасное действие.",
        [
          { text: "Отмена", style: "cancel" },
          { text: "Пометить", style: "destructive", onPress: apply },
        ],
      );
      return;
    }
    apply();
  }

  function applyLike() {
    if (currentItem) {
      commitDecision(currentItem, "good", true);
    }
  }

  function applyDelete() {
    if (currentItem) {
      commitDecision(currentItem, "purge", true);
    }
  }

  function toggleLike(item: CachedBatchItem) {
    onSetDecision(batch.batch.uid, item.id, item.decision === "good" ? null : "good");
  }

  function onInlineLikePress(event: GestureResponderEvent, item: CachedBatchItem) {
    event.stopPropagation();
    toggleLike(item);
  }

  const panResponder = PanResponder.create({
    onMoveShouldSetPanResponder: (_, gestureState) => Math.abs(gestureState.dx) > 18 && Math.abs(gestureState.dy) < 24,
    onPanResponderRelease: (_, gestureState) => {
      if (gestureState.dx < -50) {
        move(index + 1);
      }
      if (gestureState.dx > 50) {
        move(index - 1);
      }
    },
  });

  function renderBrowserCard(item: CachedBatchItem, sourceMode: ReviewMode, style: object) {
    return (
      <Pressable key={item.id} onPress={() => openItem(item, sourceMode)} style={style}>
        <ItemImage item={item} />
        <View style={styles.cardBottomMeta}>
          <Text style={styles.cardBottomMetaText}>{browserStatus(item)}</Text>
        </View>
        <Pressable
          hitSlop={8}
          onPress={(event) => onInlineLikePress(event, item)}
          style={[styles.inlineLikeButton, item.decision === "good" && styles.inlineLikeButtonActive]}
        >
          <Text style={styles.inlineLikeButtonText}>{item.decision === "good" ? "♥" : "♡"}</Text>
        </Pressable>
      </Pressable>
    );
  }

  return (
    <SafeAreaView style={[styles.safe, Platform.OS === "android" ? { paddingTop: NativeStatusBar.currentHeight ?? 0 } : null]}>
      <StatusBar style="light" />

      <View style={styles.header}>
        <Pressable onPress={handleBackNavigation} style={styles.headerButton}>
          <Text style={styles.headerButtonText}>
            {reviewMode === "single" && returnMode && returnMode !== "single" ? "Назад" : "Батчи"}
          </Text>
        </Pressable>
        <View style={styles.headerCenter}>
          <Text style={styles.progressText}>
            {Math.min(index + 1, batch.items.length)} / {Math.max(batch.items.length, 1)}
          </Text>
          <Text style={styles.progressSubtext}>
            {cachedCount}/{batch.items.length} офлайн
            {dirtyCount ? ` · sync ${dirtyCount}` : ""}
          </Text>
        </View>
        <Pressable onPress={() => void onSync()} style={[styles.headerButton, syncBusy && styles.headerButtonDisabled]} disabled={syncBusy}>
          <Text style={styles.headerButtonText}>{syncBusy ? "Sync..." : "Sync"}</Text>
        </Pressable>
      </View>

      <View style={styles.modeRow}>
        {[
          { value: "single", label: "Фото" },
          { value: "feed", label: "Лента" },
          { value: "grid", label: "Сетка" },
        ].map((item) => (
          <Pressable
            key={item.value}
            onPress={() => onChangeReviewMode(item.value as ReviewMode)}
            style={[styles.modeChip, reviewMode === item.value && styles.modeChipActive]}
          >
            <Text style={[styles.modeChipText, reviewMode === item.value && styles.modeChipTextActive]}>{item.label}</Text>
          </Pressable>
        ))}
        <Pressable onPress={() => void onRefresh()} style={styles.modeChip}>
          <Text style={styles.modeChipText}>Обновить</Text>
        </Pressable>
      </View>

      {pendingDownloadCount && !downloadBannerDismissed ? (
        <View style={styles.downloadBanner}>
          <View style={styles.downloadBannerHeader}>
            <Text style={styles.downloadBannerTitle}>
              {downloadingCount ? `Фоновые загрузки: ${downloadingCount}` : "Загрузки ждут очереди"}
            </Text>
            <Pressable hitSlop={8} onPress={() => setDownloadBannerDismissed(true)} style={styles.downloadBannerClose}>
              <Text style={styles.downloadBannerCloseText}>×</Text>
            </Pressable>
          </View>
          <Text style={styles.downloadBannerText}>
            Осталось для полного офлайна: {pendingDownloadCount}. Можно закрывать приложение: кэш и позиция уже сохраняются.
            {errorDownloadCount ? ` Ошибок: ${errorDownloadCount}.` : ""}
          </Text>
        </View>
      ) : null}

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {reviewMode === "single" ? (
        <View style={styles.viewer} {...panResponder.panHandlers}>
          {currentItem ? <ItemImage item={currentItem} immersive onRetry={() => void onRefresh()} /> : <Text style={styles.error}>Батч пуст.</Text>}
          {currentItem ? (
            <>
              <View style={styles.viewerTopOverlay}>
                <View
                  style={[
                    styles.statePill,
                    currentItem.decision === "good" && styles.likePill,
                    currentItem.decision === "purge" && styles.deletePill,
                  ]}
                >
                  <Text style={styles.statePillText}>{decisionLabel(currentItem.decision)}</Text>
                </View>
              </View>

              {showDetails ? (
                <View style={styles.detailsPanel}>
                  <Text style={styles.detailsTitle}>{currentItem.file_name}</Text>
                  <Text style={styles.detailsText}>
                    {currentItem.root_name} · {currentItem.width}x{currentItem.height}
                  </Text>
                  <Text style={styles.detailsText}>
                    cache: {currentItem.download_status} · sync: {currentItem.sync_state}
                  </Text>
                  {currentItem.last_error ? <Text style={styles.detailsError}>{currentItem.last_error}</Text> : null}
                  <Pressable onPress={() => onSetDecision(batch.batch.uid, currentItem.id, null)} style={styles.clearButton}>
                    <Text style={styles.clearButtonText}>Снять отметку</Text>
                  </Pressable>
                </View>
              ) : null}

              <View style={styles.actionBar}>
                <Pressable onPress={applyDelete} style={[styles.actionButton, styles.deleteButton]}>
                  <Text style={styles.actionButtonText}>Удалить</Text>
                </Pressable>
                <Pressable onPress={() => setShowDetails((current) => !current)} style={styles.moreButton}>
                  <Text style={styles.moreButtonText}>...</Text>
                </Pressable>
                <Pressable onPress={applyLike} style={[styles.actionButton, styles.likeButton]}>
                  <Text style={styles.actionButtonText}>Лайк</Text>
                </Pressable>
              </View>
            </>
          ) : null}
        </View>
      ) : reviewMode === "feed" ? (
        <FlatList
          ref={feedListRef}
          data={batch.items}
          keyExtractor={(item) => String(item.id)}
          contentContainerStyle={styles.browserScroll}
          contentOffset={{ x: 0, y: browserOffsetsRef.current.feed }}
          getItemLayout={(_, itemIndex) => ({
            length: feedItemLengths[itemIndex] ?? 0,
            offset: feedItemOffsets[itemIndex] ?? 0,
            index: itemIndex,
          })}
          initialNumToRender={4}
          maxToRenderPerBatch={4}
          removeClippedSubviews
          scrollEventThrottle={64}
          windowSize={4}
          onScroll={(event) => {
            browserOffsetsRef.current.feed = event.nativeEvent.contentOffset.y;
          }}
          renderItem={({ item }) => renderBrowserCard(item, "feed", styles.feedItem)}
        />
      ) : (
        <FlatList
          ref={gridListRef}
          data={gridRows}
          keyExtractor={(_, rowIndex) => `grid-${rowIndex}`}
          contentContainerStyle={styles.browserScroll}
          contentOffset={{ x: 0, y: browserOffsetsRef.current.grid }}
          initialNumToRender={6}
          maxToRenderPerBatch={6}
          removeClippedSubviews
          scrollEventThrottle={64}
          windowSize={5}
          onScroll={(event) => {
            browserOffsetsRef.current.grid = event.nativeEvent.contentOffset.y;
          }}
          renderItem={({ item: row }) =>
            row.kind === "full" ? (
              renderBrowserCard(row.item, "grid", styles.gridFull)
            ) : (
              <View style={styles.gridPair}>
                {renderBrowserCard(row.left, "grid", styles.gridHalf)}
                {row.right ? renderBrowserCard(row.right, "grid", styles.gridHalf) : <View style={styles.gridHalfSpacer} />}
              </View>
            )
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: "#0a0c0f",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 10,
    paddingTop: 6,
    paddingBottom: 8,
    gap: 10,
  },
  headerButton: {
    minHeight: 38,
    minWidth: 76,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.08)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  headerButtonDisabled: {
    opacity: 0.55,
  },
  headerButtonText: {
    color: "#f7f8fa",
    fontSize: 14,
    fontWeight: "700",
  },
  headerCenter: {
    flex: 1,
    alignItems: "center",
    gap: 2,
  },
  progressText: {
    color: "#f7f8fa",
    fontSize: 18,
    fontWeight: "800",
  },
  progressSubtext: {
    color: "#c4cad3",
    fontSize: 12,
  },
  modeRow: {
    flexDirection: "row",
    paddingHorizontal: 10,
    paddingBottom: 8,
    gap: 8,
  },
  modeChip: {
    minHeight: 36,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.08)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  modeChipActive: {
    backgroundColor: theme.accent,
  },
  modeChipText: {
    color: "#d8dde4",
    fontSize: 13,
    fontWeight: "700",
  },
  modeChipTextActive: {
    color: "#ffffff",
  },
  downloadBanner: {
    marginHorizontal: 10,
    marginBottom: 8,
    borderRadius: 18,
    backgroundColor: "#151d26",
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 4,
  },
  downloadBannerHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  downloadBannerTitle: {
    color: "#f7f8fa",
    fontSize: 13,
    fontWeight: "800",
    flex: 1,
  },
  downloadBannerClose: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.08)",
    alignItems: "center",
    justifyContent: "center",
  },
  downloadBannerCloseText: {
    color: "#ffffff",
    fontSize: 20,
    lineHeight: 22,
  },
  downloadBannerText: {
    color: "#aeb7c3",
    fontSize: 12,
    lineHeight: 18,
  },
  error: {
    color: "#ff9a9a",
    fontSize: 13,
    paddingHorizontal: 14,
    paddingBottom: 8,
  },
  viewer: {
    flex: 1,
    backgroundColor: "#050607",
  },
  viewerImage: {
    width: "100%",
    height: "100%",
  },
  previewImage: {
    width: "100%",
    backgroundColor: "#050607",
  },
  viewerTopOverlay: {
    position: "absolute",
    top: 14,
    right: 14,
  },
  statePill: {
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.12)",
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  likePill: {
    backgroundColor: "rgba(29,111,120,0.92)",
  },
  deletePill: {
    backgroundColor: "rgba(169,45,52,0.92)",
  },
  statePillText: {
    color: "#ffffff",
    fontSize: 13,
    fontWeight: "800",
  },
  actionBar: {
    position: "absolute",
    left: 10,
    right: 10,
    bottom: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  actionButton: {
    flex: 1,
    minHeight: 58,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  likeButton: {
    backgroundColor: theme.accent,
  },
  deleteButton: {
    backgroundColor: theme.danger,
  },
  actionButtonText: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "800",
  },
  moreButton: {
    width: 58,
    minHeight: 58,
    borderRadius: 22,
    backgroundColor: "rgba(255,255,255,0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  moreButtonText: {
    color: "#ffffff",
    fontSize: 24,
    fontWeight: "800",
  },
  detailsPanel: {
    position: "absolute",
    left: 10,
    right: 10,
    bottom: 82,
    borderRadius: 24,
    backgroundColor: "rgba(10,14,18,0.95)",
    padding: 16,
    gap: 6,
  },
  detailsTitle: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "800",
  },
  detailsText: {
    color: "#c4cad3",
    fontSize: 13,
    lineHeight: 20,
  },
  detailsError: {
    color: "#ff9a9a",
    fontSize: 12,
  },
  clearButton: {
    marginTop: 8,
    minHeight: 42,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.09)",
    alignItems: "center",
    justifyContent: "center",
  },
  clearButtonText: {
    color: "#f3f4f6",
    fontSize: 14,
    fontWeight: "700",
  },
  placeholder: {
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
    gap: 8,
    backgroundColor: "#050607",
  },
  viewerPlaceholder: {
    flex: 1,
  },
  previewPlaceholder: {
    width: "100%",
  },
  placeholderTitle: {
    color: "#f7f8fa",
    fontSize: 16,
    fontWeight: "700",
    textAlign: "center",
  },
  placeholderHint: {
    color: "#9aa3af",
    fontSize: 13,
    lineHeight: 20,
    textAlign: "center",
  },
  retryButton: {
    marginTop: 8,
    minHeight: 38,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.1)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  retryButtonText: {
    color: "#ffffff",
    fontSize: 13,
    fontWeight: "700",
  },
  browserScroll: {
    paddingBottom: 96,
  },
  feedItem: {
    backgroundColor: "#050607",
    marginBottom: 6,
  },
  gridFull: {
    backgroundColor: "#050607",
  },
  gridPair: {
    flexDirection: "row",
    gap: 4,
  },
  gridHalf: {
    flex: 1,
    backgroundColor: "#050607",
  },
  gridHalfSpacer: {
    flex: 1,
    backgroundColor: "#050607",
  },
  cardBottomMeta: {
    position: "absolute",
    left: 10,
    bottom: 10,
  },
  cardBottomMetaText: {
    color: "#ffffff",
    fontSize: 12,
    fontWeight: "800",
    backgroundColor: "rgba(0,0,0,0.46)",
    borderRadius: 999,
    overflow: "hidden",
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  inlineLikeButton: {
    position: "absolute",
    top: 10,
    right: 10,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(0,0,0,0.46)",
    alignItems: "center",
    justifyContent: "center",
  },
  inlineLikeButtonActive: {
    backgroundColor: "rgba(29,111,120,0.92)",
  },
  inlineLikeButtonText: {
    color: "#ffffff",
    fontSize: 20,
    fontWeight: "800",
  },
});
