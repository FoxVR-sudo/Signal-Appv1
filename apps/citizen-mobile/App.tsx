import { CameraView, useCameraPermissions } from "expo-camera";
import * as Location from "expo-location";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";

const BACKEND_URL =
  process.env.EXPO_PUBLIC_BACKEND_URL ??
  "http://127.0.0.1:4000";

export default function App() {
  const cameraRef = useRef<CameraView | null>(null);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [phone, setPhone] = useState("0888123456");
  const [isCameraOpen, setIsCameraOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [lastReportId, setLastReportId] = useState<string | null>(null);
  const [lastReportStatus, setLastReportStatus] = useState<string | null>(null);

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
      setLastReportId(payload.id);
      setLastReportStatus("assigned");
      Alert.alert("Сигналът е изпратен", `Номер: ${payload.id}`);
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
      <View style={styles.center}>
        <Text style={styles.title}>Signal Citizen</Text>

        <TextInput
          value={phone}
          onChangeText={setPhone}
          keyboardType="phone-pad"
          placeholder="Телефонен номер"
          style={styles.input}
        />

        <Pressable style={styles.button} onPress={openCamera}>
          <Text style={styles.buttonText}>Подай сигнал</Text>
        </Pressable>

        {lastReportId ? (
          <View style={styles.statusBox}>
            <Text style={styles.statusTitle}>Последен сигнал: {lastReportId.slice(0, 8)}</Text>
            <Text style={styles.statusText}>Статус: {lastReportStatus ?? "изчакване"}</Text>
          </View>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#f5f6f8" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
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
  }
});
