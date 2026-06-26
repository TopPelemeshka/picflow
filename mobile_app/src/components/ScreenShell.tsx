import type { PropsWithChildren, ReactNode } from "react";
import { Platform, SafeAreaView, ScrollView, StatusBar as NativeStatusBar, StyleSheet, Text, View } from "react-native";

import { theme } from "../lib/theme";

type Props = PropsWithChildren<{
  title: string;
  subtitle?: string;
  headerRight?: ReactNode;
  scroll?: boolean;
}>;

export function ScreenShell({ title, subtitle, headerRight, scroll = true, children }: Props) {
  const body = (
    <View style={styles.inner}>
      <View style={styles.header}>
        <View style={styles.headerCopy}>
          <Text style={styles.eyebrow}>PicFlow Mobile</Text>
          <Text style={styles.title}>{title}</Text>
          {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
        </View>
        {headerRight}
      </View>
      {children}
    </View>
  );

  return (
    <SafeAreaView style={[styles.safe, Platform.OS === "android" ? { paddingTop: NativeStatusBar.currentHeight ?? 0 } : null]}>
      {scroll ? <ScrollView contentContainerStyle={styles.scroll}>{body}</ScrollView> : body}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: theme.bg,
  },
  scroll: {
    paddingBottom: 36,
  },
  inner: {
    flex: 1,
    paddingHorizontal: 18,
    paddingTop: 12,
    gap: 16,
  },
  header: {
    gap: 12,
  },
  headerCopy: {
    gap: 6,
  },
  eyebrow: {
    color: theme.accent,
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 1.2,
    textTransform: "uppercase",
  },
  title: {
    color: theme.text,
    fontSize: 30,
    fontWeight: "800",
  },
  subtitle: {
    color: theme.muted,
    fontSize: 15,
    lineHeight: 22,
  },
});
