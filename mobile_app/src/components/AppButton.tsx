import { Pressable, StyleSheet, Text, ViewStyle } from "react-native";

import { theme } from "../lib/theme";

type Props = {
  label: string;
  onPress: () => void;
  tone?: "primary" | "danger" | "ghost" | "soft";
  disabled?: boolean;
  style?: ViewStyle;
};

export function AppButton({ label, onPress, tone = "soft", disabled = false, style }: Props) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        tone === "primary" && styles.primary,
        tone === "danger" && styles.danger,
        tone === "ghost" && styles.ghost,
        disabled && styles.disabled,
        pressed && !disabled && styles.pressed,
        style,
      ]}
    >
      <Text
        style={[
          styles.label,
          tone === "primary" && styles.primaryLabel,
          tone === "danger" && styles.primaryLabel,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: 48,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.panelSoft,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  primary: {
    backgroundColor: theme.accent,
    borderColor: theme.accent,
  },
  danger: {
    backgroundColor: theme.danger,
    borderColor: theme.danger,
  },
  ghost: {
    backgroundColor: "transparent",
  },
  disabled: {
    opacity: 0.45,
  },
  pressed: {
    transform: [{ scale: 0.985 }],
  },
  label: {
    color: theme.text,
    fontSize: 15,
    fontWeight: "700",
  },
  primaryLabel: {
    color: "#ffffff",
  },
});
