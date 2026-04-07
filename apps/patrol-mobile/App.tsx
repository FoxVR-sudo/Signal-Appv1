import { useEffect, useMemo, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Application from "expo-application";
import * as Location from "expo-location";
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
  status: "submitted" | "assigned" | "accepted" | "on_site" | "closed" | "validated" | "rejected";
  assignedUnitId: string | null;
  acceptedAt: string | null;
  arrivedAt: string | null;
  closedAt: string | null;
};

type ShiftLog = {
  startedAt: string;
  acceptedIds: string[];
  arrivedIds: string[];
  closedIds: string[];
};

const API_BASE =
  process.env.EXPO_PUBLIC_BACKEND_URL ??
  "https://signal-backend-8pyp.onrender.com";
const UNIT_ID_FALLBACK = process.env.EXPO_PUBLIC_PATROL_UNIT_ID ?? "";
const EAS_PROJECT_ID = "6106f6c5-ccb5-470f-8e2e-87821b98c257";
const DEVICE_ID_KEY = "@signal/patrol-device-id";
const UNIT_ID_KEY = "@signal/patrol-unit-id";
const UNIT_LABEL_KEY = "@signal/patrol-unit-label";
const SHIFT_STORAGE_PREFIX = "@signal/patrol-shift/";

const createEmptyShiftLog = (): ShiftLog => ({
  startedAt: new Date().toISOString(),
  acceptedIds: [],
  arrivedIds: [],
  closedIds: []
});

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
  const [unitId, setUnitId] = useState<string>(UNIT_ID_FALLBACK);
  const [unitLabel, setUnitLabel] = useState<string>("");
  const [dispatchNotice, setDispatchNotice] = useState<string | null>(null);
  const [pendingActionReportId, setPendingActionReportId] = useState<string | null>(null);
  const [pushState, setPushState] = useState<string>("Push: инициализация...");
  const [previewPhotoUrl, setPreviewPhotoUrl] = useState<string | null>(null);
  const [shiftLog, setShiftLog] = useState<ShiftLog>(createEmptyShiftLog);
  const shiftStorageKey = `${SHIFT_STORAGE_PREFIX}${unitId || "unassigned"}`;

  useEffect(() => {
    const loadShiftLog = async () => {
      try {
        const raw = await AsyncStorage.getItem(shiftStorageKey);
        if (!raw) {
          return;
        }

        const parsed = JSON.parse(raw) as Partial<ShiftLog>;
        if (!parsed.startedAt) {
          return;
        }

        setShiftLog({
          startedAt: parsed.startedAt,
          acceptedIds: Array.isArray(parsed.acceptedIds) ? parsed.acceptedIds : [],
          arrivedIds: Array.isArray(parsed.arrivedIds) ? parsed.arrivedIds : [],
          closedIds: Array.isArray(parsed.closedIds) ? parsed.closedIds : []
        });
      } catch {
        // Ignore corrupted local shift log.
      }
    };

    void loadShiftLog();
  }, [shiftStorageKey]);

  useEffect(() => {
    AsyncStorage.setItem(shiftStorageKey, JSON.stringify(shiftLog)).catch(() => {
      // Ignore local persistence errors.
    });
  }, [shiftLog, shiftStorageKey]);

  const getPatrolLocation = async () => {
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (!permission.granted) {
        return { lat: 42.6977, lng: 23.3219 };
      }

      const current = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      return {
        lat: current.coords.latitude,
        lng: current.coords.longitude
      };
    } catch {
      return { lat: 42.6977, lng: 23.3219 };
    }
  };

  const resolveDeviceId = async () => {
    const saved = await AsyncStorage.getItem(DEVICE_ID_KEY);
    if (saved?.trim()) {
      return saved;
    }

    const fromPlatform = Platform.OS === "android"
      ? await Application.getAndroidId()
      : Application.getIosIdForVendorAsync ? await Application.getIosIdForVendorAsync() : null;
    const generated = fromPlatform || `device-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await AsyncStorage.setItem(DEVICE_ID_KEY, generated);
    return generated;
  };

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
    void refreshReports();
  }, [unitId]);

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

          setReports((prev) => {
            if (!unitId || report.assignedUnitId !== unitId) {
              return prev;
            }
            if (prev.some((item) => item.id === report.id)) return prev;
            return [report, ...prev];
          });

          if (!report.assignedUnitId || report.assignedUnitId === unitId) {
            setDispatchNotice(`Нов сигнал: ${report.id.slice(0, 8)}`);
            Vibration.vibrate([120, 80, 120]);
          }
        }

        if (payload.type === "report_assigned" || payload.type === "report_reassigned") {
          const data = payload.data as { reportId: string; unitId: string; unitLabel?: string };
          if (data?.unitId === unitId) {
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
            const belongsToUnit = Boolean(unitId) && report.assignedUnitId === unitId;

            if (!belongsToUnit) {
              if (existingIndex >= 0) {
                return prev.filter((item) => item.id !== report.id);
              }
              return prev;
            }

            const isNewForThisUnit = existingIndex < 0;

            if (isNewForThisUnit && report.status === "assigned") {
              setDispatchNotice(`Сигнал към теб: ${report.id.slice(0, 8)}`);
              Vibration.vibrate([150, 60, 150]);
              void dispatchLocalNotification(report, false);
            }

            if (existingIndex >= 0) {
              return prev.map((item) => (item.id === report.id ? report : item));
            }

            return [report, ...prev];
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
  }, [websocketUrl, unitId]);

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
        const deviceId = await resolveDeviceId();
        const location = await getPatrolLocation();

        const response = await fetch(`${API_BASE}/patrol/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            deviceId,
            token,
            platform: Platform.OS,
            lat: location.lat,
            lng: location.lng
          })
        });

        if (!response.ok) {
          setPushState(`Push: registration failed (${response.status})`);
          return;
        }

        const payload = (await response.json()) as { unitId: string; label: string };
        setUnitId(payload.unitId);
        setUnitLabel(payload.label);
        await AsyncStorage.setItem(UNIT_ID_KEY, payload.unitId);
        await AsyncStorage.setItem(UNIT_LABEL_KEY, payload.label);
        setPushState(`Push: активно (${payload.label})`);
      } catch (error) {
        const message =
          error instanceof Error ? error.message.slice(0, 90) : "unknown error";
        setPushState(`Push: недостъпно (${message})`);
      }
    };

    const loadCachedUnit = async () => {
      try {
        const cachedId = await AsyncStorage.getItem(UNIT_ID_KEY);
        const cachedLabel = await AsyncStorage.getItem(UNIT_LABEL_KEY);
        if (cachedId?.trim()) {
          setUnitId(cachedId);
        }
        if (cachedLabel?.trim()) {
          setUnitLabel(cachedLabel);
        }
      } catch {
        // Ignore cache read errors.
      }
    };

    void loadCachedUnit();
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
  }, []);

  useEffect(() => {
    if (!unitId) return;

    let stopped = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const sendHeartbeat = async () => {
      if (stopped) return;
      try {
        const location = await getPatrolLocation();
        await fetch(`${API_BASE}/patrol/units/${unitId}/heartbeat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lat: location.lat, lng: location.lng })
        });
      } catch {
        // Ignore heartbeat errors.
      }
    };

    void sendHeartbeat();
    timer = setInterval(() => {
      void sendHeartbeat();
    }, 20_000);

    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
    };
  }, [unitId]);

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
        body: JSON.stringify({ unitId })
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
      setShiftLog((prev) => {
        if (action === "accept") {
          if (prev.acceptedIds.includes(reportId)) return prev;
          return { ...prev, acceptedIds: [...prev.acceptedIds, reportId] };
        }

        if (action === "arrived") {
          if (prev.arrivedIds.includes(reportId)) return prev;
          return { ...prev, arrivedIds: [...prev.arrivedIds, reportId] };
        }

        if (prev.closedIds.includes(reportId)) return prev;
        return { ...prev, closedIds: [...prev.closedIds, reportId] };
      });
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
    if (report.assignedUnitId !== unitId) {
      return [] as const;
    }

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

  const getColleagueStatusLabel = (report: ReportRecord) => {
    if (!report.assignedUnitId || report.assignedUnitId === unitId) {
      return null;
    }

    if (!unitId) {
      return null;
    }

    switch (report.status) {
      case "assigned":
        return `Разпределен към ${report.assignedUnitId}`;
      case "accepted":
        return `Приет от ${report.assignedUnitId}`;
      case "on_site":
        return `${report.assignedUnitId} е на място`;
      case "closed":
        return `Приключен от ${report.assignedUnitId}`;
      case "validated":
        return `Потвърден от админ`;
      case "rejected":
        return `Отхвърлен от админ`;
      default:
        return `Обработва се от ${report.assignedUnitId}`;
    }
  };

  const formatServerStageTime = (value: string | null) => {
    if (!value) return "-";
    return new Date(value).toLocaleString("bg-BG");
  };

  const refreshReports = async () => {
    if (!unitId) {
      setReports([]);
      return;
    }

    try {
      const response = await fetch(`${API_BASE}/patrol/incidents/live?unitId=${encodeURIComponent(unitId)}`);
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

  const startNewShift = () => {
    Alert.alert("Нова смяна", "Да занулим статистиката и да започнем нова смяна?", [
      { text: "Отказ", style: "cancel" },
      {
        text: "Да",
        style: "destructive",
        onPress: () => setShiftLog(createEmptyShiftLog())
      }
    ]);
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
        <Text style={styles.subtitle}>Идентификатор: {unitLabel || unitId || "(регистрация...)"}</Text>
        <Text style={styles.subtitle}>
          Статус: {isConnected ? "Свързано в реално време" : "Изчаква връзка"}
        </Text>
        <Text style={styles.subtitle}>{pushState}</Text>
        <View style={styles.shiftBox}>
          <Text style={styles.shiftTitle}>
            Смяна: {new Date(shiftLog.startedAt).toLocaleString("bg-BG", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" })}
          </Text>
          <Text style={styles.shiftStat}>Отзовали сигнали: {shiftLog.acceptedIds.length}</Text>
          <Text style={styles.shiftStat}>На място: {shiftLog.arrivedIds.length}</Text>
          <Text style={styles.shiftStat}>Приключени: {shiftLog.closedIds.length}</Text>
          <Pressable style={styles.newShiftButton} onPress={startNewShift}>
            <Text style={styles.newShiftButtonText}>Нова смяна</Text>
          </Pressable>
        </View>
        {dispatchNotice ? <Text style={styles.notice}>{dispatchNotice}</Text> : null}
      </View>

      <FlatList
        data={reports}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <View style={styles.card}>
            {getColleagueStatusLabel(item) ? (
              <View style={styles.colleagueStateRow}>
                <Text style={styles.colleagueStateText}>{getColleagueStatusLabel(item)}</Text>
              </View>
            ) : null}
            <View style={styles.cardTopRow}>
              <Text style={styles.cardTitle}>Сигнал: {item.id.slice(0, 8)}</Text>
              {item.assignedUnitId && item.assignedUnitId !== unitId && item.status !== "closed" ? (
                <View style={styles.colleagueBadge}>
                  <Text style={styles.colleagueBadgeText}>Колега</Text>
                </View>
              ) : null}
            </View>
            <Pressable onPress={() => setPreviewPhotoUrl(item.photoUrl)}>
              <Image source={{ uri: item.photoUrl }} style={styles.photo} resizeMode="cover" />
              <View style={styles.photoHintChip}>
                <Text style={styles.photoHintChipText}>Отвори снимката</Text>
              </View>
            </Pressable>
            <Text style={styles.cardText}>Патрул: {item.assignedUnitId ?? "в изчакване"}</Text>
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
              Получен: {new Date(item.receivedAtServer).toLocaleString("bg-BG")}
            </Text>
            <View style={styles.timelineBox}>
              <Text style={styles.timelineTitle}>Етапи (сървърно време)</Text>
              <Text style={styles.timelineText}>Приет: {formatServerStageTime(item.acceptedAt)}</Text>
              <Text style={styles.timelineText}>На място: {formatServerStageTime(item.arrivedAt)}</Text>
              <Text style={styles.timelineText}>Приключен: {formatServerStageTime(item.closedAt)}</Text>
            </View>
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
                <Text style={styles.actionMuted}>
                  {item.assignedUnitId === unitId
                    ? "Няма следващо действие"
                    : "Информация: сигналът се обработва от друг патрул"}
                </Text>
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
  shiftBox: {
    marginTop: 2,
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#d6dee8",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 4
  },
  shiftTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: "#0f172a"
  },
  shiftStat: {
    fontSize: 14,
    color: "#334155"
  },
  newShiftButton: {
    alignSelf: "flex-start",
    marginTop: 6,
    backgroundColor: "#f1f5f9",
    borderWidth: 1,
    borderColor: "#cbd5e1",
    borderRadius: 9,
    paddingHorizontal: 12,
    paddingVertical: 8
  },
  newShiftButtonText: {
    color: "#0f172a",
    fontWeight: "700"
  },
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
  colleagueStateRow: {
    marginBottom: 8,
    alignSelf: "flex-start",
    backgroundColor: "#eff6ff",
    borderWidth: 1,
    borderColor: "#93c5fd",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6
  },
  colleagueStateText: {
    color: "#1d4ed8",
    fontSize: 12,
    fontWeight: "700"
  },
  cardTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
    gap: 8
  },
  colleagueBadge: {
    backgroundColor: "#fef3c7",
    borderWidth: 1,
    borderColor: "#fbbf24",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4
  },
  colleagueBadgeText: {
    color: "#92400e",
    fontSize: 12,
    fontWeight: "700"
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
  timelineBox: {
    marginTop: 8,
    backgroundColor: "#f8fafc",
    borderWidth: 1,
    borderColor: "#e2e8f0",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 2
  },
  timelineTitle: {
    fontSize: 12,
    fontWeight: "700",
    color: "#1e293b",
    marginBottom: 2
  },
  timelineText: {
    fontSize: 12,
    color: "#334155"
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
