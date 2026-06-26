import { Component, useEffect, useState } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";

import { ConnectScreen } from "./src/screens/ConnectScreen";
import { BatchHubScreen } from "./src/screens/BatchHubScreen";
import { ReviewScreen } from "./src/screens/ReviewScreen";
import { theme } from "./src/lib/theme";
import { useAppModel } from "./src/state/useAppModel";

type FatalState = {
  message: string;
  stack?: string;
};

type BoundaryProps = {
  children: ReactNode;
  onError: (error: Error, info: ErrorInfo) => void;
};

type BoundaryState = {
  hasError: boolean;
};

class RootErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { hasError: false };

  static getDerivedStateFromError(): BoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.props.onError(error, info);
  }

  render() {
    if (this.state.hasError) {
      return null;
    }
    return this.props.children;
  }
}

function AppInner() {
  const model = useAppModel();

  if (model.booting) {
    return (
      <View style={styles.boot}>
        <StatusBar style="dark" />
        <ActivityIndicator color={theme.accent} size="large" />
        <Text style={styles.bootText}>Загрузка PicFlow Mobile…</Text>
      </View>
    );
  }

  return (
    <>
      <StatusBar style="dark" />
      {!model.session ? (
        <ConnectScreen
          busy={model.busy}
          error={model.error}
          initialDeviceName={model.connectionDraft.deviceName}
          initialServerUrl={model.connectionDraft.serverUrl}
          onConnect={model.connect}
        />
      ) : model.activeBatch ? (
        <ReviewScreen
          batch={model.activeBatch}
          busy={model.busy}
          error={model.error}
          reviewMode={model.reviewMode}
          onBack={() => model.setActiveBatchUid(null)}
          onChangeReviewMode={model.setReviewMode}
          onRefresh={model.refreshActiveBatch}
          onSetCursor={model.setBatchCursor}
          onSetDecision={model.setDecision}
          onSync={model.syncActiveBatch}
        />
      ) : (
        <BatchHubScreen
          activeBatchUid={model.activeBatchUid}
          busy={model.busy}
          capabilities={model.capabilities}
          error={model.error}
          localBatches={model.localBatches}
          onCreateBatch={model.createBatch}
          onDisconnect={model.disconnect}
          onDownloadBatch={model.downloadBatch}
          onOpenBatch={model.setActiveBatchUid}
          onRemoveBatch={model.removeBatch}
          onRefresh={model.refreshAll}
          onSyncBatch={model.syncBatch}
          remoteBatches={model.remoteBatches}
          roots={model.roots}
          session={model.session}
        />
      )}
    </>
  );
}

function FatalScreen({ state, onReset }: { state: FatalState; onReset: () => void }) {
  return (
    <View style={styles.fatal}>
      <StatusBar style="dark" />
      <Text style={styles.fatalEyebrow}>PicFlow Mobile</Text>
      <Text style={styles.fatalTitle}>Приложение остановилось из-за ошибки</Text>
      <Text style={styles.fatalMessage}>{state.message}</Text>
      {state.stack ? <Text style={styles.fatalStack}>{state.stack}</Text> : null}
      <Pressable onPress={onReset} style={styles.resetButton}>
        <Text style={styles.resetButtonLabel}>Попробовать перезапуск экрана</Text>
      </Pressable>
    </View>
  );
}

export default function App() {
  const [fatal, setFatal] = useState<FatalState | null>(null);

  useEffect(() => {
    const errorUtils = (globalThis as typeof globalThis & {
      ErrorUtils?: {
        getGlobalHandler?: () => ((error: unknown, isFatal?: boolean) => void) | undefined;
        setGlobalHandler?: (handler: (error: unknown, isFatal?: boolean) => void) => void;
      };
    }).ErrorUtils;

    const previousHandler = errorUtils?.getGlobalHandler?.();
    errorUtils?.setGlobalHandler?.((error, isFatal) => {
      const nextError = error instanceof Error ? error : new Error(String(error));
      setFatal({
        message: isFatal ? `Fatal JS error: ${nextError.message}` : nextError.message,
        stack: nextError.stack,
      });
    });

    return () => {
      if (previousHandler) {
        errorUtils?.setGlobalHandler?.(previousHandler);
      }
    };
  }, []);

  if (fatal) {
    return <FatalScreen onReset={() => setFatal(null)} state={fatal} />;
  }

  return (
    <RootErrorBoundary
      onError={(error, info) =>
        setFatal({
          message: error.message,
          stack: [error.stack, info.componentStack].filter(Boolean).join("\n\n"),
        })
      }
    >
      <AppInner />
    </RootErrorBoundary>
  );
}

const styles = StyleSheet.create({
  boot: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.bg,
    gap: 14,
  },
  bootText: {
    color: theme.muted,
    fontSize: 15,
  },
  fatal: {
    flex: 1,
    backgroundColor: theme.bg,
    paddingHorizontal: 20,
    paddingVertical: 28,
    gap: 14,
  },
  fatalEyebrow: {
    color: theme.accent,
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 1.2,
    textTransform: "uppercase",
  },
  fatalTitle: {
    color: theme.text,
    fontSize: 28,
    fontWeight: "800",
  },
  fatalMessage: {
    color: theme.danger,
    fontSize: 16,
    lineHeight: 24,
  },
  fatalStack: {
    color: theme.muted,
    fontSize: 12,
    lineHeight: 18,
  },
  resetButton: {
    minHeight: 52,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 18,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.panel,
    paddingHorizontal: 16,
  },
  resetButtonLabel: {
    color: theme.text,
    fontSize: 15,
    fontWeight: "700",
  },
});
