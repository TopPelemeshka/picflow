import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, TextInput, View } from "react-native";

import { AppButton } from "../components/AppButton";
import { ScreenShell } from "../components/ScreenShell";
import { theme } from "../lib/theme";

type Props = {
  busy: string | null;
  error: string | null;
  initialServerUrl: string;
  initialDeviceName: string;
  onConnect: (serverUrl: string, code: string, deviceName: string) => Promise<void>;
};

export function ConnectScreen({ busy, error, initialServerUrl, initialDeviceName, onConnect }: Props) {
  const [serverUrl, setServerUrl] = useState(initialServerUrl);
  const [deviceName, setDeviceName] = useState(initialDeviceName);
  const [code, setCode] = useState("");

  useEffect(() => {
    setServerUrl(initialServerUrl);
  }, [initialServerUrl]);

  useEffect(() => {
    setDeviceName(initialDeviceName);
  }, [initialDeviceName]);

  async function submit() {
    await onConnect(serverUrl, code, deviceName);
  }

  return (
    <ScreenShell
      title="Подключить телефон"
      subtitle="Введи адрес сервера PicFlow в локальной сети, имя устройства и одноразовый pairing-код с ПК. Последние адрес и имя сохраняются."
    >
      <View style={styles.card}>
        <Text style={styles.label}>Сервер</Text>
        <TextInput
          autoCapitalize="none"
          keyboardType="url"
          onChangeText={setServerUrl}
          placeholder="http://192.168.0.10:8765"
          placeholderTextColor="#958f88"
          style={styles.input}
          value={serverUrl}
        />

        <Text style={styles.label}>Имя устройства</Text>
        <TextInput
          onChangeText={setDeviceName}
          placeholder="My phone"
          placeholderTextColor="#958f88"
          style={styles.input}
          value={deviceName}
        />

        <Text style={styles.label}>Pairing code</Text>
        <TextInput
          autoCapitalize="characters"
          onChangeText={setCode}
          placeholder="ABC123"
          placeholderTextColor="#958f88"
          style={styles.input}
          value={code}
        />

        {error ? <Text style={styles.error}>{error}</Text> : null}
        <AppButton disabled={Boolean(busy)} label={busy ?? "Подключить"} onPress={submit} tone="primary" />
        {busy ? <ActivityIndicator color={theme.accent} /> : null}
      </View>

      <View style={styles.note}>
        <Text style={styles.noteTitle}>Как это работает</Text>
        <Text style={styles.noteText}>1. На ПК открой экран Mobile Review и сгенерируй pairing-code.</Text>
        <Text style={styles.noteText}>2. Запусти сервер PicFlow в LAN: `python -m picflow runserver --host 0.0.0.0 --port 8765`.</Text>
        <Text style={styles.noteText}>3. Телефон и ПК должны быть в одной сети только на этапе подключения, скачивания и синхронизации.</Text>
        <Text style={styles.noteText}>4. После подключения батчи можно разбирать офлайн и возвращаться к ним с того же места.</Text>
      </View>
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.panel,
    borderRadius: 28,
    borderWidth: 1,
    borderColor: theme.border,
    padding: 18,
    gap: 10,
  },
  label: {
    color: theme.text,
    fontWeight: "700",
    fontSize: 14,
  },
  input: {
    minHeight: 52,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: "#ffffff",
    paddingHorizontal: 14,
    color: theme.text,
    fontSize: 16,
  },
  error: {
    color: theme.danger,
    fontSize: 14,
    lineHeight: 20,
  },
  note: {
    backgroundColor: "#fff7ef",
    borderRadius: 24,
    borderWidth: 1,
    borderColor: theme.border,
    padding: 18,
    gap: 8,
  },
  noteTitle: {
    color: theme.accentStrong,
    fontSize: 16,
    fontWeight: "800",
  },
  noteText: {
    color: theme.muted,
    fontSize: 14,
    lineHeight: 21,
  },
});
