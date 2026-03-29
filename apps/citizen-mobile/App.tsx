import AsyncStorage from "@react-native-async-storage/async-storage";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Location from "expo-location";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
const BACKEND_URL =
  process.env.EXPO_PUBLIC_BACKEND_URL ??
  "https://signal-backend-8pyp.onrender.com";
const SAVED_PHONE_KEY = "@signal/citizen-phone";
const HISTORY_KEY = "@signal/citizen-history";

type HistoryEntry = {
  id: string;
  submittedAt: string;
  status: string;
  assignedUnitId: string | null;
  verified: boolean;
  verifiedAt: string | null;
};

type RewardSummary = {
  monthKey: string;
  submittedCount: number;
  acceptedCount: number;
  acceptanceRate: number;
  participantCount: number;
  averageSubmittedCount: number;
  averageAcceptedCount: number;
  verifiedCount: number;
  eligibleForReward: boolean;
  targetVerifiedCount: number;
  remainingForReward: number;
  leaderboardRank: number | null;
};

export default function App() {
  const cameraRef = useRef<CameraView | null>(null);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [phone, setPhone] = useState("");
  const [isPhoneLoaded, setIsPhoneLoaded] = useState(false);
  const [isCameraOpen, setIsCameraOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [lastReportId, setLastReportId] = useState<string | null>(null);
  const [lastReportStatus, setLastReportStatus] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [rewardSummary, setRewardSummary] = useState<RewardSummary | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);

  const normalizePhone = (value: string) => {
    const digits = value.replace(/\D/g, "");

    // Unify BG mobile formats: +35988XXXXXXX, 35988XXXXXXX, 088XXXXXXX, 88XXXXXXX.
    if (digits.startsWith("359") && digits.length === 12) {
      return `0${digits.slice(3)}`;
    }

    if (digits.startsWith("8") && digits.length === 9) {
      return `0${digits}`;
    }

    if (digits.startsWith("0") && digits.length === 10) {
      return digits;
    }

    return digits;
  };

  const hasValidPhone = normalizePhone(phone).length >= 10;

  useEffect(() => {
    const loadSavedPhone = async () => {
      try {
        const savedPhone = await AsyncStorage.getItem(SAVED_PHONE_KEY);
        if (savedPhone?.trim()) {
          setPhone(savedPhone.trim());
        }
      } finally {
        setIsPhoneLoaded(true);
      }
    };

    const loadHistory = async () => {
      try {
        const raw = await AsyncStorage.getItem(HISTORY_KEY);
        if (raw) setHistory(JSON.parse(raw) as HistoryEntry[]);
      } catch {
        // Ignore corrupted history.
      }
    };

    void loadSavedPhone();
    void loadHistory();
  }, []);

  const syncHistoryFromServer = async (phoneValue: string) => {
    const normalizedPhone = normalizePhone(phoneValue);
    if (normalizedPhone.length < 8) {
      setRewardSummary(null);
      setStatsError("Въведи валиден телефонен номер за статистика.");
      return;
    }

    setStatsLoading(true);
    setStatsError(null);
    try {
      const response = await fetch(`${BACKEND_URL}/citizen/history/${encodeURIComponent(normalizedPhone)}`);
      if (!response.ok) {
        setStatsError(`Статистиката е недостъпна (${response.status}).`);
        return;
      }

      const payload = (await response.json()) as {
        history: HistoryEntry[];
        rewards: RewardSummary;
      };

      setHistory(payload.history);
      setRewardSummary(payload.rewards);
      await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(payload.history));

      if (payload.history[0]) {
        setLastReportId(payload.history[0].id);
        setLastReportStatus(payload.history[0].status);
      } else {
        setLastReportId(null);
        setLastReportStatus(null);
      }
    } catch {
      setStatsError("Неуспешна връзка със сървъра за статистика.");
    } finally {
      setStatsLoading(false);
    }
  };

  const getLocationWithFallback = async () => {
    const withTimeout = async <T,>(promise: Promise<T>, timeoutMs: number) => {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error("location timeout")), timeoutMs))
      ]);
    };

    try {
      return await withTimeout(
        Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Highest }),
        7000
      );
    } catch {
      // Continue to lower-power fallbacks.
    }

    try {
      return await withTimeout(
        Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
        5000
      );
    } catch {
      // Continue to last known fallback.
    }

    const lastKnown = await Location.getLastKnownPositionAsync({ maxAge: 120000, requiredAccuracy: 250 });
    if (lastKnown) {
      return lastKnown;
    }

    throw new Error("Неуспешно определяне на местоположение.");
  };

  const openCamera = async () => {
    if (!hasValidPhone) {
      Alert.alert("Липсва телефон", "Въведи валиден телефонен номер.");
      return;
    }

    if (!cameraPermission?.granted) {
      const cameraResult = await requestCameraPermission();
      if (!cameraResult.granted) {
        Alert.alert("Няма достъп", "Приложението няма достъп до камера.");
        return;
      }
    }

    const locationPermission = await Location.requestForegroundPermissionsAsync();
    if (!locationPermission.granted) {
      Alert.alert("Няма локация", "Разреши GPS достъп, за да подадеш сигнал.");
      return;
    }

    if (Platform.OS === "android") {
      try {
        // Improves precision indoors by allowing Wi-Fi/cellular assisted positioning.
        await Location.enableNetworkProviderAsync();
      } catch {
        // User may decline; app can continue with available providers.
      }
    }

    setIsCameraOpen(true);
  };

  const captureAndSend = async () => {
    if (!cameraRef.current || isSubmitting) {
      return;
    }

    setIsSubmitting(true);
    try {
      const normalizedPhone = normalizePhone(phone);
      const picture = await cameraRef.current.takePictureAsync({
        base64: true,
        quality: 0.7
      });

      if (!picture.base64) {
        throw new Error("Снимката не беше заснета успешно.");
      }

      const location = await getLocationWithFallback();

      const accuracy = location.coords.accuracy ?? 250;
      if (accuracy > 250) {
        throw new Error("Сигналът за местоположение е твърде слаб. Включи Wi-Fi/интернет и опитай отново.");
      }

      if (accuracy > 120) {
        Alert.alert("Слаб GPS", "Локацията е приблизителна, но сигналът ще бъде изпратен.");
      }

      const response = await fetch(`${BACKEND_URL}/reports`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone: normalizedPhone,
          photoBase64: picture.base64,
          lat: location.coords.latitude,
          lng: location.coords.longitude,
          gpsAccuracyM: accuracy,
          capturedAtDevice: new Date().toISOString()
        })
      });

      if (!response.ok) {
        throw new Error("Сигналът не беше приет от сървъра.");
      }

      const payload = (await response.json()) as { id: string };
      await AsyncStorage.setItem(SAVED_PHONE_KEY, normalizedPhone);

      const newEntry: HistoryEntry = {
        id: payload.id,
        submittedAt: new Date().toISOString(),
        status: "submitted",
        assignedUnitId: null,
        verified: false,
        verifiedAt: null
      };
      const updatedHistory = [newEntry, ...history].slice(0, 10);
      setHistory(updatedHistory);
      await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(updatedHistory));

      setLastReportId(payload.id);
      setLastReportStatus("submitted");
      void syncHistoryFromServer(normalizedPhone);
      Alert.alert("Сигналът е изпратен", `Номер: ${payload.id.slice(0, 8)}`);
      setIsCameraOpen(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Възникна неочаквана грешка.";
      Alert.alert("Неуспешно изпращане", message);
    } finally {
      setIsSubmitting(false);
    }
  };

  useEffect(() => {
    if (!isPhoneLoaded) {
      return;
    }

    const normalizedPhone = normalizePhone(phone);
    if (normalizedPhone.length < 8) {
      setRewardSummary(null);
      return;
    }

    void syncHistoryFromServer(normalizedPhone);
    const timer = setInterval(() => {
      void syncHistoryFromServer(normalizedPhone);
    }, 15_000);

    return () => clearInterval(timer);
  }, [phone, isPhoneLoaded]);

  if (isCameraOpen) {
    return (
      <SafeAreaView style={styles.cameraRoot}>
        <CameraView ref={cameraRef} style={styles.cameraView} facing="back" />
        <View style={styles.cameraHintBar}>
          <Text style={styles.cameraHintText}>Уверете се, че нарушението е изцяло в кадъра</Text>
        </View>
        <View style={styles.cameraOverlay}>
          <Pressable style={styles.cancelButton} onPress={() => setIsCameraOpen(false)}>
            <Text style={styles.cancelButtonText}>Отказ</Text>
          </Pressable>

          <Pressable
            style={[styles.captureButton, isSubmitting && styles.captureButtonDisabled]}
            onPress={captureAndSend}
            disabled={isSubmitting}
          >
            {isSubmitting ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.captureButtonText}>Снимай и изпрати</Text>
            )}
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Signal Citizen</Text>


        <View style={styles.hintBox}>
          <Text style={styles.hintText}>
            Преди да изпратите сигнал, уверете се, че нарушението е ясно видимо и изцяло в кадъра на снимката. Снимайте при добра осветеност.
          </Text>
        </View>

        <TextInput
          value={phone}
          onChangeText={setPhone}
          keyboardType="phone-pad"
          placeholder="Телефонен номер (задължително)"
          autoComplete="tel"
          textContentType="telephoneNumber"
          style={styles.input}
          editable={isPhoneLoaded}
        />

        <Text style={styles.requiredHint}>Телефонният номер е задължителен за подаване на сигнал.</Text>

        <Pressable
          style={[styles.button, !hasValidPhone && styles.buttonDisabled]}
          onPress={openCamera}
          disabled={!hasValidPhone}
        >
          <Text style={styles.buttonText}>Подай сигнал</Text>
        </Pressable>

        {lastReportId ? (
          <View style={styles.statusBox}>
            <Text style={styles.statusTitle}>Последен сигнал: {lastReportId.slice(0, 8)}</Text>
            <Text style={styles.statusText}>Статус: {translateStatus(lastReportStatus ?? "")}</Text>
          </View>
        ) : null}

        <View style={styles.rewardBox}>
          <Text style={styles.rewardTitle}>Твоят рейтинг</Text>
          {statsLoading ? <Text style={styles.rewardText}>Зареждане на рейтинг...</Text> : null}
          {statsError ? <Text style={styles.rewardError}>{statsError}</Text> : null}

          {rewardSummary ? (
            <>
              <Text style={styles.ratingMain}>
                {rewardSummary.leaderboardRank
                  ? `#${rewardSummary.leaderboardRank} от ${rewardSummary.participantCount}`
                  : `Без класиране (${rewardSummary.participantCount} участника)`}
              </Text>
              <Text style={styles.rewardText}>Месец: {rewardSummary.monthKey}</Text>
              <Text style={styles.rewardText}>Изпратени сигнали: {rewardSummary.submittedCount}</Text>
              <Text style={styles.rewardText}>Приети от патрул: {rewardSummary.acceptedCount}</Text>
              <Text style={styles.rewardText}>
                Процент приети: {(rewardSummary.acceptanceRate * 100).toFixed(0)}%
              </Text>
              <Text style={styles.rewardHint}>
                Средно за гражданин: {rewardSummary.averageSubmittedCount.toFixed(1)} изпратени / {rewardSummary.averageAcceptedCount.toFixed(1)} приети
              </Text>
            </>
          ) : (
            <Text style={styles.rewardText}>Няма налична статистика за този номер.</Text>
          )}
        </View>

        {history.length > 0 ? (
          <View style={styles.historySection}>
            <Text style={styles.historyTitle}>История на сигналите</Text>
            {history.map((entry) => (
              <View key={entry.id} style={styles.historyRow}>
                <View style={styles.historyLeft}>
                  <Text style={styles.historyId}>{entry.id.slice(0, 8)}</Text>
                  <Text style={styles.historyDate}>
                    {new Date(entry.submittedAt).toLocaleString("bg-BG", {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit"
                    })}
                  </Text>
                  <Text style={styles.historyMeta}>
                    {entry.verified
                      ? `Потвърден: ${entry.verifiedAt ? new Date(entry.verifiedAt).toLocaleString("bg-BG") : "да"}`
                      : `Патрул: ${entry.assignedUnitId ?? "в изчакване"}`}
                  </Text>
                </View>
                <Text
                  style={[
                    styles.historyStatus,
                    entry.verified && styles.historyStatusVerified,
                    entry.status === "closed" && styles.historyStatusClosed
                  ]}
                  >
                    {entry.verified ? "Потвърден" : translateStatus(entry.status)}
                  </Text>
                </View>
            ))}
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const translateStatus = (status: string) => {
  switch (status) {
    case "submitted": return "Подаден";
    case "assigned": return "Разпределен към патрул";
    case "accepted": return "Приет от патрул";
    case "on_site": return "Патрулът е на място";
    case "closed": return "Приключен";
    default: return status || "изчакване";
  }
};

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#f5f6f8" },
  scroll: { flexGrow: 1, alignItems: "center", paddingTop: 48, paddingBottom: 32, paddingHorizontal: 24 },
  title: { fontSize: 28, fontWeight: "800", marginBottom: 20 },
  input: {
    width: "100%",
    maxWidth: 320,
    borderWidth: 1,
    borderColor: "#ced4da",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 16,
    backgroundColor: "#fff",
    fontSize: 16
  },
  button: {
    minWidth: 240,
    backgroundColor: "#0b3d91",
    borderRadius: 14,
    paddingVertical: 18,
    paddingHorizontal: 24,
    alignItems: "center"
  },
  buttonDisabled: {
    opacity: 0.45
  },
  buttonText: { color: "#fff", fontSize: 20, fontWeight: "700" },
  requiredHint: {
    width: "100%",
    maxWidth: 320,
    marginTop: -4,
    marginBottom: 14,
    fontSize: 12,
    lineHeight: 18,
    color: "#7c2d12"
  },
  statusBox: {
    width: "100%",
    maxWidth: 320,
    marginTop: 18,
    borderRadius: 12,
    padding: 12,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#d5dde8"
  },
  statusTitle: {
    fontSize: 14,
    fontWeight: "700",
    marginBottom: 4
  },
  statusText: {
    fontSize: 14,
    color: "#334155"
  },
  rewardBox: {
    width: "100%",
    maxWidth: 320,
    marginTop: 18,
    borderRadius: 14,
    padding: 14,
    backgroundColor: "#fdf7e7",
    borderWidth: 1,
    borderColor: "#efd38a",
    gap: 4
  },
  rewardTitle: {
    fontSize: 16,
    fontWeight: "800",
    color: "#7c4a03"
  },
  ratingMain: {
    marginTop: 6,
    marginBottom: 2,
    fontSize: 30,
    fontWeight: "900",
    color: "#7c4a03"
  },
  rewardText: {
    fontSize: 14,
    color: "#6b4f1d"
  },
  rewardError: {
    fontSize: 13,
    color: "#b91c1c",
    backgroundColor: "#fee2e2",
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 6
  },
  rewardHint: {
    marginTop: 4,
    fontSize: 12,
    lineHeight: 18,
    color: "#8b6b2b"
  },
  rewardRank: {
    marginTop: 4,
    fontSize: 14,
    fontWeight: "700",
    color: "#7c4a03"
  },
  cameraRoot: { flex: 1, backgroundColor: "#000" },
  cameraView: { flex: 1 },
  cameraOverlay: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 30,
    paddingHorizontal: 20,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center"
  },
    cameraHintBar: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      paddingTop: 48,
      paddingBottom: 12,
      paddingHorizontal: 16,
      backgroundColor: "rgba(0,0,0,0.55)",
      alignItems: "center",
    },
    cameraHintText: {
      color: "#fff",
      fontSize: 13,
      fontWeight: "600",
      textAlign: "center",
      letterSpacing: 0.2,
    },
    hintBox: {
      width: "100%",
      maxWidth: 320,
      backgroundColor: "#e8f0fe",
      borderRadius: 12,
      padding: 12,
      marginBottom: 16,
      borderLeftWidth: 3,
      borderLeftColor: "#0b3d91",
    },
    hintText: {
      fontSize: 13,
      color: "#1a3a6b",
      lineHeight: 19,
    },
  cancelButton: {
    backgroundColor: "rgba(255,255,255,0.2)",
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 10
  },
  cancelButtonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600"
  },
  captureButton: {
    backgroundColor: "#0b3d91",
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 10,
    minWidth: 170,
    alignItems: "center"
  },
  captureButtonDisabled: {
    opacity: 0.7
  },
  captureButtonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700"
  },
  historySection: {
    width: "100%",
    maxWidth: 320,
    marginTop: 24
  },
  historyTitle: {
    fontSize: 16,
    fontWeight: "700",
    marginBottom: 10,
    color: "#1e293b"
  },
  historyRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: "#fff",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: "#e2e8f0"
  },
  historyLeft: { gap: 2 },
  historyId: { fontSize: 14, fontWeight: "700", color: "#0b3d91" },
  historyDate: { fontSize: 12, color: "#64748b" },
  historyMeta: { fontSize: 12, color: "#64748b", maxWidth: 190 },
  historyStatus: { fontSize: 13, fontWeight: "600", color: "#0b3d91" },
  historyStatusVerified: { color: "#0f766e" },
  historyStatusClosed: { color: "#64748b" }
});
