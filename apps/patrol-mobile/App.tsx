import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  FlatList,
  Image,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  Vibration,
  View
} from "react-native";

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

export default function App() {
  const [reports, setReports] = useState<ReportRecord[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [dispatchNotice, setDispatchNotice] = useState<string | null>(null);
  const [pendingActionReportId, setPendingActionReportId] = useState<string | null>(null);

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

  useEffect(() => {
    void refreshReports();
  }, [dispatchNotice]);

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>Patrol Live Feed</Text>
        <Text style={styles.subtitle}>
          Статус: {isConnected ? "Свързано в реално време" : "Изчаква връзка"}
        </Text>
        {dispatchNotice ? <Text style={styles.notice}>{dispatchNotice}</Text> : null}
      </View>

      <FlatList
        data={reports}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <View style={styles.card}>
            <Image source={{ uri: item.photoUrl }} style={styles.photo} />
            <Text style={styles.cardTitle}>Сигнал: {item.id.slice(0, 8)}</Text>
            <Text style={styles.cardText}>Телефон: {item.phone}</Text>
            <Text style={styles.cardText}>
              Координати: {item.lat.toFixed(5)}, {item.lng.toFixed(5)}
            </Text>
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
  cardTitle: { fontSize: 16, fontWeight: "700", marginBottom: 4 },
  cardText: { fontSize: 14, color: "#334155" },
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
  }
});
