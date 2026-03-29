import AsyncStorage from "@react-native-async-storage/async-storage";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Location from "expo-location";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  PermissionsAndroid,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import DeviceInfo from "react-native-device-info";
const BACKEND_URL =
  process.env.EXPO_PUBLIC_BACKEND_URL ??
  "https://signal-backend-8pyp.onrender.com";
const SAVED_PHONE_KEY = "@signal/citizen-phone";
const HISTORY_KEY = "@signal/citizen-history";

type HistoryEntry = { id: string; submittedAt: string; status: string };

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

  useEffect(() => {
    const loadSavedPhone = async () => {
      try {
        // 1. Try AsyncStorage first (previously confirmed number)
        const savedPhone = await AsyncStorage.getItem(SAVED_PHONE_KEY);
        if (savedPhone?.trim()) {
          setPhone(savedPhone.trim());
          return;
        }

        // 2. Try to read the SIM phone number from the device
        if (Platform.OS === "android") {
          try {
            const granted = await PermissionsAndroid.request(
              PermissionsAndroid.PERMISSIONS.READ_PHONE_NUMBERS
            );
            if (granted === PermissionsAndroid.RESULTS.GRANTED) {
              const devicePhone = await DeviceInfo.getPhoneNumber();
              if (devicePhone && devicePhone !== "unknown" && devicePhone.length >= 8) {
                setPhone(devicePhone);
              }
            }
          } catch {
            // Device doesn't expose SIM number; leave field empty.
          }
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
    if (phone.trim().length < 8) {
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
          phone: phone.trim(),
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
      await AsyncStorage.setItem(SAVED_PHONE_KEY, phone.trim());

      const newEntry: HistoryEntry = {
        id: payload.id,
        submittedAt: new Date().toISOString(),
        status: "submitted"
      };
      const updatedHistory = [newEntry, ...history].slice(0, 10);
      setHistory(updatedHistory);
      await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(updatedHistory));

      setLastReportId(payload.id);
      setLastReportStatus("submitted");
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
    if (!lastReportId) {
      return;
    }

    const timer = setInterval(async () => {
      try {
        const response = await fetch(`${BACKEND_URL}/reports/${lastReportId}`);
        if (!response.ok) {
          return;
        }

        const payload = (await response.json()) as { status: string };
        setLastReportStatus(payload.status);

        setHistory((prev) => {
          const updated = prev.map((e) =>
            e.id === lastReportId ? { ...e, status: payload.status } : e
          );
          AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(updated)).catch(() => {});
          return updated;
        });
      } catch {
        // Skip transient network errors.
      }
    }, 4000);

    return () => clearInterval(timer);
  }, [lastReportId]);

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
          placeholder="Телефонен номер"
          autoComplete="tel"
          textContentType="telephoneNumber"
          style={styles.input}
          editable={isPhoneLoaded}
        />

        <Pressable style={styles.button} onPress={openCamera}>
          <Text style={styles.buttonText}>Подай сигнал</Text>
        </Pressable>

        {lastReportId ? (
          <View style={styles.statusBox}>
            <Text style={styles.statusTitle}>Последен сигнал: {lastReportId.slice(0, 8)}</Text>
            <Text style={styles.statusText}>Статус: {translateStatus(lastReportStatus ?? "")}</Text>
          </View>
        ) : null}

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
                </View>
                <Text
                  style={[
                    styles.historyStatus,
                    entry.status === "closed" && styles.historyStatusClosed
                  ]}
                  >
                    {translateStatus(entry.status)}
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
  buttonText: { color: "#fff", fontSize: 20, fontWeight: "700" },
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
  historyStatus: { fontSize: 13, fontWeight: "600", color: "#0b3d91" },
  historyStatusClosed: { color: "#64748b" }
});
