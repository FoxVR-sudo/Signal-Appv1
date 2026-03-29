import { useEffect, useMemo, useState } from "react";
import {
  AppState,
  Alert,
  FlatList,
  Image,
  Linking,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  Vibration,
  View
} from "react-native";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";

type ReportRecord = {
  id: string;
  phone: string;
  photoUrl: string;
  lat: number;
  lng: number;
  gpsAccuracyM: number;
  capturedAtDevice: string;
  receivedAtServer: string;
  status: "submitted" | "assigned" | "accepted" | "on_site" | "closed";
  assignedUnitId: string | null;
};

const API_BASE =
  process.env.EXPO_PUBLIC_BACKEND_URL ??
  "https://signal-backend-8pyp.onrender.com";
const UNIT_ID = process.env.EXPO_PUBLIC_PATROL_UNIT_ID ?? "patrol-1";
const EAS_PROJECT_ID = "6106f6c5-ccb5-470f-8e2e-87821b98c257";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false
  })
});

export default function App() {
  const [reports, setReports] = useState<ReportRecord[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [dispatchNotice, setDispatchNotice] = useState<string | null>(null);
  const [pendingActionReportId, setPendingActionReportId] = useState<string | null>(null);
  const [pushState, setPushState] = useState<string>("Push: инициализация...");
  const [previewPhotoUrl, setPreviewPhotoUrl] = useState<string | null>(null);

  const dispatchLocalNotification = async (report: ReportRecord, isReassigned: boolean) => {
    try {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: isReassigned ? "Пренасочен сигнал" : "Нов сигнал",
          body: `Тел: ${report.phone} | ${report.lat.toFixed(4)}, ${report.lng.toFixed(4)}`,
          sound: "default",
          priority: Notifications.AndroidNotificationPriority.MAX,
          data: { reportId: report.id }
        },
        trigger: null
      });
    } catch {
      // Ignore local notification errors.
    }
  };

  const websocketUrl = useMemo(() => {
    if (API_BASE.startsWith("https://")) {
      return API_BASE.replace("https://", "wss://") + "/ws/patrol";
    }
    return API_BASE.replace("http://", "ws://") + "/ws/patrol";
  }, []);

  useEffect(() => {
    const loadInitialReports = async () => {
      try {
        const response = await fetch(`${API_BASE}/patrol/incidents/live?unitId=${UNIT_ID}`);
        if (!response.ok) {
          return;
        }

        const payload = (await response.json()) as ReportRecord[];
        setReports(payload);
      } catch {
        // Ignore transient startup errors.
      }
    };

    void loadInitialReports();
  }, []);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let unmounted = false;

    const handleMessage = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as { type: string; data: unknown };

        if (payload.type === "report_created") {
          const report = payload.data as ReportRecord;
          if (!report) return;

          if (!report.assignedUnitId || report.assignedUnitId === UNIT_ID) {
            setReports((prev) => [report, ...prev]);
            setDispatchNotice(`Нов сигнал: ${report.id.slice(0, 8)}`);
            Vibration.vibrate([120, 80, 120]);
          }
        }

        if (payload.type === "report_assigned" || payload.type === "report_reassigned") {
          const data = payload.data as { reportId: string; unitId: string; unitLabel?: string };
          if (data?.unitId === UNIT_ID) {
            setDispatchNotice(`Разпределен сигнал: ${data.reportId.slice(0, 8)}`);
            Vibration.vibrate([180, 80, 180, 80, 180]);

            const report = reports.find((item) => item.id === data.reportId);
            if (report) {
              void dispatchLocalNotification(report, payload.type === "report_reassigned");
            }
          }
        }

        if (payload.type === "report_updated") {
          const report = payload.data as ReportRecord;
          if (!report) return;

          setReports((prev) => {
            const existingIndex = prev.findIndex((item) => item.id === report.id);
            const belongsToUnit = !report.assignedUnitId || report.assignedUnitId === UNIT_ID;
            const isNewForThisUnit = existingIndex < 0 && belongsToUnit;

            if (isNewForThisUnit && report.status === "assigned") {
              setDispatchNotice(`Сигнал към теб: ${report.id.slice(0, 8)}`);
              Vibration.vibrate([150, 60, 150]);
              void dispatchLocalNotification(report, false);
            }

            if (existingIndex >= 0) {
              if (!belongsToUnit) {
                return prev.filter((item) => item.id !== report.id);
              }
              return prev.map((item) => (item.id === report.id ? report : item));
            }

            if (belongsToUnit) {
              return [report, ...prev];
            }

            return prev;
          });
        }
      } catch {
        // Ignore malformed socket events.
      }
    };

    const connect = () => {
      if (unmounted) return;
      ws = new WebSocket(websocketUrl);

      ws.onopen = () => {
        if (!unmounted) {
          setIsConnected(true);
          void refreshReports();
        }
      };

      ws.onclose = () => {
        if (!unmounted) {
          setIsConnected(false);
          reconnectTimer = setTimeout(connect, 5000);
        }
      };

      ws.onerror = () => {
        if (!unmounted) setIsConnected(false);
      };

      ws.onmessage = handleMessage;
    };

    connect();

    return () => {
      unmounted = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [websocketUrl]);

  useEffect(() => {
    const refreshTimer = setInterval(() => {
      void refreshReports();
    }, 30_000);
    return () => clearInterval(refreshTimer);
  }, []);

  useEffect(() => {
    const registerPush = async () => {
      try {
        if (Platform.OS === "android") {
          await Notifications.setNotificationChannelAsync("dispatch", {
            name: "Dispatch",
            importance: Notifications.AndroidImportance.MAX,
            vibrationPattern: [0, 200, 120, 200],
            lightColor: "#0b3d91"
          });
        }

        const permissions = await Notifications.getPermissionsAsync();
        let finalStatus = permissions.status;
        if (finalStatus !== "granted") {
          const requested = await Notifications.requestPermissionsAsync();
          finalStatus = requested.status;
        }

        if (finalStatus !== "granted") {
          setPushState("Push: отказано разрешение");
          return;
        }

        const projectId =
          Constants.easConfig?.projectId ??
          ((Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas
            ?.projectId ??
            EAS_PROJECT_ID);

        if (!projectId) {
          setPushState("Push: липсва projectId");
          return;
        }

        const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
        const response = await fetch(`${API_BASE}/patrol/units/${UNIT_ID}/push-token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, platform: Platform.OS })
        });

        if (!response.ok) {
          setPushState(`Push: token registration failed (${response.status})`);
          return;
        }

        setPushState("Push: активно");
      } catch (error) {
        const message =
          error instanceof Error ? error.message.slice(0, 90) : "unknown error";
        setPushState(`Push: недостъпно (${message})`);
      }
    };

    void registerPush();

    const responseSub = Notifications.addNotificationResponseReceivedListener(() => {
      void refreshReports();
      setDispatchNotice("Отворен сигнал от известие");
    });

    const receiveSub = Notifications.addNotificationReceivedListener(() => {
      void refreshReports();
    });

    const appStateSub = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        void refreshReports();
      }
    });

    return () => {
      responseSub.remove();
      receiveSub.remove();
      appStateSub.remove();
    };
  }, [reports]);

  const updateStatus = async (reportId: string, action: "accept" | "arrived" | "close") => {
    setPendingActionReportId(reportId);
    try {
      const endpoint =
        action === "accept"
          ? "accept"
          : action === "arrived"
            ? "arrived"
            : "close";

      const response = await fetch(`${API_BASE}/patrol/incidents/${reportId}/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unitId: UNIT_ID })
      });

      if (!response.ok) {
        let errorMessage = "Операцията не беше приета от сървъра.";

        try {
          const payload = (await response.json()) as { error?: string };
          if (payload?.error) {
            errorMessage = payload.error;
          }
        } catch {
          // Ignore malformed error payloads.
        }

        Alert.alert("Неуспешно действие", errorMessage);
        return;
      }

      const payload = (await response.json()) as { report: ReportRecord };
      setReports((prev) => prev.map((item) => (item.id === reportId ? payload.report : item)));
      setDispatchNotice(
        action === "accept"
          ? `Сигналът е приет: ${reportId.slice(0, 8)}`
          : action === "arrived"
            ? `Маркиран на място: ${reportId.slice(0, 8)}`
            : `Сигналът е приключен: ${reportId.slice(0, 8)}`
      );
    } finally {
      setPendingActionReportId(null);
    }
  };

  const getAvailableActions = (report: ReportRecord) => {
    if (report.status === "assigned") {
      return [{ key: "accept", label: "Приемам" }] as const;
    }

    if (report.status === "accepted") {
      return [{ key: "arrived", label: "На място" }] as const;
    }

    if (report.status === "on_site") {
      return [{ key: "close", label: "Приключи" }] as const;
    }

    return [] as const;
  };

  const refreshReports = async () => {
    try {
      const response = await fetch(`${API_BASE}/patrol/incidents/live?unitId=${UNIT_ID}`);
      if (!response.ok) {
        return;
      }

      const payload = (await response.json()) as ReportRecord[];
      setReports(payload);
    } catch {
      // Ignore transient refresh errors.
    }
  };

  const openInMaps = async (report: ReportRecord) => {
    const label = encodeURIComponent(`Signal ${report.id.slice(0, 8)}`);
    const androidUrl = `geo:${report.lat},${report.lng}?q=${report.lat},${report.lng}(${label})`;
    const iosUrl = `http://maps.apple.com/?ll=${report.lat},${report.lng}&q=${label}`;
    const webUrl = `https://www.google.com/maps/search/?api=1&query=${report.lat},${report.lng}`;
    const primaryUrl = Platform.OS === "android" ? androidUrl : iosUrl;

    try {
      const supported = await Linking.canOpenURL(primaryUrl);
      await Linking.openURL(supported ? primaryUrl : webUrl);
    } catch {
      Alert.alert("Maps недостъпно", "Координатите не можаха да бъдат отворени в приложение за карти.");
    }
  };

  useEffect(() => {
    void refreshReports();
  }, [dispatchNotice]);

  return (
    <SafeAreaView style={styles.root}>
      <Modal
        visible={previewPhotoUrl !== null}
        animationType="fade"
        transparent={true}
        onRequestClose={() => setPreviewPhotoUrl(null)}
      >
        <View style={styles.previewBackdrop}>
          <Pressable style={styles.previewClose} onPress={() => setPreviewPhotoUrl(null)}>
            <Text style={styles.previewCloseText}>Затвори</Text>
          </Pressable>
          {previewPhotoUrl ? (
            <Image source={{ uri: previewPhotoUrl }} style={styles.previewPhoto} resizeMode="contain" />
          ) : null}
        </View>
      </Modal>

      <View style={styles.header}>
        <Text style={styles.title}>Patrol Live Feed</Text>
        <Text style={styles.subtitle}>
          Статус: {isConnected ? "Свързано в реално време" : "Изчаква връзка"}
        </Text>
        <Text style={styles.subtitle}>{pushState}</Text>
        {dispatchNotice ? <Text style={styles.notice}>{dispatchNotice}</Text> : null}
      </View>

      <FlatList
        data={reports}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <View style={styles.card}>
            <Pressable onPress={() => setPreviewPhotoUrl(item.photoUrl)}>
              <Image source={{ uri: item.photoUrl }} style={styles.photo} resizeMode="cover" />
              <View style={styles.photoHintChip}>
                <Text style={styles.photoHintChipText}>Отвори снимката</Text>
              </View>
            </Pressable>
            <Text style={styles.cardTitle}>Сигнал: {item.id.slice(0, 8)}</Text>
            <Text style={styles.cardText}>Телефон: {item.phone}</Text>
            <Text style={styles.cardText}>
              Координати: {item.lat.toFixed(5)}, {item.lng.toFixed(5)}
            </Text>
            <Pressable style={styles.mapButton} onPress={() => void openInMaps(item)}>
              <Text style={styles.mapButtonText}>Отвори пин в Maps</Text>
            </Pressable>
            <Text style={styles.cardText}>Точност: {Math.round(item.gpsAccuracyM)} м</Text>
            <Text style={styles.cardText}>Статус: {item.status}</Text>
            <Text style={styles.cardText}>
              Получен: {new Date(item.receivedAtServer).toLocaleString()}
            </Text>
            <View style={styles.actions}>
              {getAvailableActions(item).length ? (
                getAvailableActions(item).map((action) => (
                  <Pressable
                    key={action.key}
                    style={[styles.actionButton, pendingActionReportId === item.id && styles.actionButtonDisabled]}
                    disabled={pendingActionReportId === item.id}
                    onPress={() => void updateStatus(item.id, action.key)}
                  >
                    <Text style={styles.actionButtonText}>{action.label}</Text>
                  </Pressable>
                ))
              ) : (
                <Text style={styles.actionMuted}>Няма следващо действие</Text>
              )}
            </View>
          </View>
        )}
        ListEmptyComponent={<Text style={styles.empty}>Няма входящи сигнали.</Text>}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#eef2f7" },
  header: { padding: 20, gap: 8 },
  title: { fontSize: 24, fontWeight: "800" },
  subtitle: { fontSize: 15, color: "#425466" },
  notice: {
    marginTop: 6,
    backgroundColor: "#fff3bf",
    borderColor: "#f59f00",
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    color: "#7c2d12",
    fontWeight: "700"
  },
  list: { paddingHorizontal: 16, paddingBottom: 24, gap: 12 },
  card: {
    backgroundColor: "#fff",
    borderRadius: 14,
    padding: 12,
    borderWidth: 1,
    borderColor: "#d6dee8"
  },
  photo: {
    width: "100%",
    height: 180,
    borderRadius: 10,
    marginBottom: 10,
    backgroundColor: "#d5dce5"
  },
  photoHintChip: {
    position: "absolute",
    right: 10,
    bottom: 20,
    backgroundColor: "rgba(8,18,36,0.82)",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6
  },
  photoHintChipText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "700"
  },
  cardTitle: { fontSize: 16, fontWeight: "700", marginBottom: 4 },
  cardText: { fontSize: 14, color: "#334155" },
  mapButton: {
    alignSelf: "flex-start",
    marginTop: 8,
    marginBottom: 2,
    backgroundColor: "#e8f0fe",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#bfdbfe",
    paddingHorizontal: 12,
    paddingVertical: 9
  },
  mapButtonText: {
    color: "#0b3d91",
    fontWeight: "700"
  },
  actions: {
    marginTop: 10,
    flexDirection: "row",
    gap: 10,
    flexWrap: "wrap"
  },
  actionButton: {
    backgroundColor: "#0b3d91",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10
  },
  actionButtonDisabled: {
    opacity: 0.7
  },
  actionButtonText: {
    color: "#fff",
    fontWeight: "700"
  },
  actionMuted: {
    color: "#64748b",
    fontWeight: "600"
  },
  empty: {
    textAlign: "center",
    color: "#64748b",
    marginTop: 40,
    fontSize: 16
  },
  previewBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.92)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
    paddingVertical: 32
  },
  previewPhoto: {
    width: "100%",
    height: "82%",
    backgroundColor: "#111827"
  },
  previewClose: {
    alignSelf: "flex-end",
    marginBottom: 12,
    backgroundColor: "rgba(255,255,255,0.12)",
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 9
  },
  previewCloseText: {
    color: "#fff",
    fontWeight: "700"
  }
});
