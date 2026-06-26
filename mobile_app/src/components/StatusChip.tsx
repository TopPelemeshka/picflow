import { StyleSheet, Text, View } from "react-native";

import { theme } from "../lib/theme";

type Props = {
  label: string;
  tone?: "accent" | "ok" | "warn" | "danger" | "neutral";
};

export function StatusChip({ label, tone = "neutral" }: Props) {
  return (
    <View style={[styles.base, tone === "accent" && styles.accent, tone === "ok" && styles.ok, tone === "warn" && styles.warn, tone === "danger" && styles.danger]}>
      <Text style={[styles.label, tone === "accent" && styles.accentLabel, tone === "ok" && styles.okLabel, tone === "warn" && styles.warnLabel, tone === "danger" && styles.dangerLabel]}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: "#f0ebe3",
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  accent: {
    backgroundColor: theme.accentSoft,
    borderColor: "#b7d8db",
  },
  ok: {
    backgroundColor: theme.okSoft,
    borderColor: "#c0e2d1",
  },
  warn: {
    backgroundColor: theme.warnSoft,
    borderColor: "#f0c7b8",
  },
  danger: {
    backgroundColor: theme.dangerSoft,
    borderColor: "#ecbcc2",
  },
  label: {
    color: theme.text,
    fontWeight: "700",
    fontSize: 12,
  },
  accentLabel: {
    color: theme.accentStrong,
  },
  okLabel: {
    color: theme.ok,
  },
  warnLabel: {
    color: theme.warn,
  },
  dangerLabel: {
    color: theme.danger,
  },
});
