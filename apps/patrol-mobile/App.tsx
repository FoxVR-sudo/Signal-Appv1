import { useEffect, useMemo, useState } from "react";
import { FlatList, Image, Platform, SafeAreaView, StyleSheet, Text, Vibration, View } from "react-native";

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
  (Platform.OS === "android" ? "http://10.0.2.2:4000" : "http://127.0.0.1:4000");
const UNIT_ID = process.env.EXPO_PUBLIC_PATROL_UNIT_ID ?? "patrol-1";

export default function App() {
  const [reports, setReports] = useState<ReportRecord[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [dispatchNotice, setDispatchNotice] = useState<string | null>(null);

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
    const ws = new WebSocket(websocketUrl);

    ws.onopen = () => setIsConnected(true);
    ws.onclose = () => setIsConnected(false);
    ws.onerror = () => setIsConnected(false);
    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data as string) as { type: string; data: unknown };

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

    return () => ws.close();
  }, [websocketUrl]);

  const updateStatus = async (reportId: string, action: "accept" | "arrived" | "close") => {
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
      return;
    }

    const payload = (await response.json()) as { report: ReportRecord };
    setReports((prev) => prev.map((item) => (item.id === reportId ? payload.report : item)));
  };

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
              <Text style={styles.action} onPress={() => void updateStatus(item.id, "accept")}>
                Приемам
              </Text>
              <Text style={styles.action} onPress={() => void updateStatus(item.id, "arrived")}>
                На място
              </Text>
              <Text style={styles.action} onPress={() => void updateStatus(item.id, "close")}>
                Приключи
              </Text>
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
    justifyContent: "space-between"
  },
  action: {
    color: "#0b3d91",
    fontWeight: "700"
  },
  empty: {
    textAlign: "center",
    color: "#64748b",
    marginTop: 40,
    fontSize: 16
  }
});
