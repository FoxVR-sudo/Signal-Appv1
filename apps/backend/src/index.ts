import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";

type ReportStatus = "submitted" | "assigned" | "accepted" | "on_site" | "closed";

type ReportRecord = {
  id: string;
  phone: string;
  photoUrl: string;
  lat: number;
  lng: number;
  gpsAccuracyM: number;
  capturedAtDevice: string;
  receivedAtServer: string;
  status: ReportStatus;
  assignedUnitId: string | null;
  assignmentAttempts: string[];
  acceptedAt: string | null;
  arrivedAt: string | null;
  closedAt: string | null;
};

type PatrolUnit = {
  id: string;
  label: string;
  deviceId: string;
  platform: "android" | "ios";
  lat: number;
  lng: number;
  lastSeenAt: string;
  isAvailable: boolean;
  activeReportId: string | null;
};

const app = Fastify({
  logger: true,
  bodyLimit: 10 * 1024 * 1024
});

await app.register(cors, { origin: true });
await app.register(websocket);

const reports: ReportRecord[] = [];
const patrolUnits: PatrolUnit[] = [];

const clients = new Set<import("ws").WebSocket>();
const reassignmentTimers = new Map<string, NodeJS.Timeout>();
const ASSIGNMENT_TIMEOUT_MS = 120_000;
const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const patrolPushTokens = new Map<string, Set<string>>();
const PUSH_TOKEN_STORE_DIR = path.join(process.cwd(), ".data");
const PUSH_TOKEN_STORE_PATH = path.join(PUSH_TOKEN_STORE_DIR, "patrol-push-tokens.json");
const REPORT_STORE_DIR = path.join(process.cwd(), ".data");
const REPORT_STORE_PATH = path.join(REPORT_STORE_DIR, "reports.json");
const PATROL_UNIT_STORE_PATH = path.join(process.cwd(), ".data", "patrol-units.json");
const PATROL_ACTIVE_WINDOW_MS = 6 * 60 * 60 * 1000;

const toRadians = (value: number) => (value * Math.PI) / 180;

const haversineMeters = (lat1: number, lng1: number, lat2: number, lng2: number) => {
  const earthRadius = 6_371_000;
  const deltaLat = toRadians(lat2 - lat1);
  const deltaLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(deltaLng / 2) ** 2;
  return 2 * earthRadius * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const broadcast = (type: string, data: unknown) => {
  const message = JSON.stringify({ type, data });
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(message);
  }
};

const isExpoPushToken = (token: string) => /^ExponentPushToken\[[\w-]+\]$/.test(token);

const loadPatrolPushTokens = async () => {
  try {
    const raw = await fs.readFile(PUSH_TOKEN_STORE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, string[]>;

    for (const [unitId, tokens] of Object.entries(parsed)) {
      const valid = (tokens ?? []).filter((token) => typeof token === "string" && isExpoPushToken(token));
      if (valid.length) {
        patrolPushTokens.set(unitId, new Set(valid));
      }
    }

    app.log.info({ units: patrolPushTokens.size }, "Loaded patrol push token store");
    broadcastPatrolUnitsUpdated();
  } catch {
    app.log.info("No persisted patrol push token store found");
  }
};

const persistPatrolPushTokens = async () => {
  const snapshot: Record<string, string[]> = {};
  for (const [unitId, tokens] of patrolPushTokens.entries()) {
    snapshot[unitId] = [...tokens];
  }

  try {
    await fs.mkdir(PUSH_TOKEN_STORE_DIR, { recursive: true });
    await fs.writeFile(PUSH_TOKEN_STORE_PATH, JSON.stringify(snapshot), "utf-8");
  } catch (error) {
    app.log.warn({ error }, "Failed to persist patrol push token store");
  }
};

const persistPatrolUnits = async () => {
  try {
    await fs.mkdir(path.dirname(PATROL_UNIT_STORE_PATH), { recursive: true });
    await fs.writeFile(PATROL_UNIT_STORE_PATH, JSON.stringify(patrolUnits), "utf-8");
  } catch (error) {
    app.log.warn({ error }, "Failed to persist patrol units store");
  }
};

const loadPatrolUnits = async () => {
  try {
    const raw = await fs.readFile(PATROL_UNIT_STORE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as PatrolUnit[];
    if (!Array.isArray(parsed)) {
      return;
    }

    patrolUnits.splice(0, patrolUnits.length, ...parsed);
    app.log.info({ count: patrolUnits.length }, "Loaded patrol units store");
    broadcastPatrolUnitsUpdated();
  } catch {
    app.log.info("No persisted patrol units store found");
  }
};

const getNextPatrolNumber = () => {
  const max = patrolUnits.reduce((acc, unit) => {
    const match = /^patrol-(\d+)$/.exec(unit.id);
    if (!match) return acc;
    const value = Number(match[1]);
    return Number.isFinite(value) ? Math.max(acc, value) : acc;
  }, 0);

  return max + 1;
};

const getPatrolUnitById = (unitId: string) => patrolUnits.find((unit) => unit.id === unitId);

const upsertPatrolUnit = (input: {
  deviceId: string;
  platform: "android" | "ios";
  lat: number;
  lng: number;
}) => {
  const existing = patrolUnits.find((unit) => unit.deviceId === input.deviceId);
  const nowIso = new Date().toISOString();

  if (existing) {
    existing.platform = input.platform;
    existing.lat = input.lat;
    existing.lng = input.lng;
    existing.lastSeenAt = nowIso;
    return existing;
  }

  const number = getNextPatrolNumber();
  const created: PatrolUnit = {
    id: `patrol-${number}`,
    label: `Патрул ${number}`,
    deviceId: input.deviceId,
    platform: input.platform,
    lat: input.lat,
    lng: input.lng,
    lastSeenAt: nowIso,
    isAvailable: true,
    activeReportId: null
  };
  patrolUnits.push(created);
  return created;
};

const isUnitReachable = (unitId: string) => {
  const tokens = patrolPushTokens.get(unitId);
  return Boolean(tokens && tokens.size > 0);
};

const isUnitActiveRecently = (unit: PatrolUnit) => {
  const seenAt = new Date(unit.lastSeenAt).getTime();
  return Number.isFinite(seenAt) && Date.now() - seenAt <= PATROL_ACTIVE_WINDOW_MS;
};

const isUnitAssignable = (unit: PatrolUnit) => {
  return unit.isAvailable && isUnitReachable(unit.id) && isUnitActiveRecently(unit);
};

const getPatrolUnitsSnapshot = () =>
  patrolUnits.map((unit) => ({
    ...unit,
    reachable: isUnitReachable(unit.id),
    active: isUnitActiveRecently(unit),
    assignable: isUnitAssignable(unit)
  }));

const broadcastPatrolUnitsUpdated = () => {
  broadcast("patrol_units_updated", getPatrolUnitsSnapshot());
};

const loadReports = async () => {
  try {
    const raw = await fs.readFile(REPORT_STORE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as ReportRecord[];
    if (!Array.isArray(parsed)) {
      return;
    }

    reports.splice(0, reports.length, ...parsed);

    // Rebuild unit availability from persisted open incidents.
    for (const unit of patrolUnits) {
      unit.isAvailable = true;
      unit.activeReportId = null;
    }

    for (const report of parsed) {
      // If a report is assigned to a unit with no reachable channel, put it back to dispatch queue.
      if (
        report.assignedUnitId &&
        report.status !== "closed" &&
        (!isUnitReachable(report.assignedUnitId) || !getPatrolUnitById(report.assignedUnitId))
      ) {
        report.assignedUnitId = null;
        report.status = "submitted";
      }

      if (!report.assignedUnitId) continue;
      if (report.status === "closed") continue;

      const unit = patrolUnits.find((item) => item.id === report.assignedUnitId);
      if (!unit) continue;
      unit.isAvailable = false;
      unit.activeReportId = report.id;
    }

    app.log.info({ count: reports.length }, "Loaded persisted reports store");
  } catch {
    app.log.info("No persisted reports store found");
  }
};

const persistReports = async () => {
  try {
    await fs.mkdir(REPORT_STORE_DIR, { recursive: true });
    await fs.writeFile(REPORT_STORE_PATH, JSON.stringify(reports), "utf-8");
  } catch (error) {
    app.log.warn({ error }, "Failed to persist reports store");
  }
};

const sendPushToUnit = async (
  unitId: string,
  title: string,
  body: string,
  data: Record<string, string>
) => {
  const tokens = patrolPushTokens.get(unitId);
  if (!tokens?.size) {
    return;
  }

  const messages = [...tokens].map((token) => ({
    to: token,
    title,
    body,
    sound: "default",
    priority: "high",
    channelId: "dispatch",
    data
  }));

  try {
    const response = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify(messages)
    });

    if (!response.ok) {
      app.log.warn({ unitId, status: response.status }, "Failed to send Expo push notification");
      return;
    }

    const payload = (await response.json()) as {
      data?: Array<{ status: "ok" | "error"; details?: { error?: string } }>;
    };

    let removedInvalidToken = false;
    payload.data?.forEach((ticket, index) => {
      if (ticket.status !== "error") {
        return;
      }

      const token = messages[index]?.to;
      app.log.warn({ unitId, token, error: ticket.details?.error }, "Expo push ticket returned error");
      if (ticket.details?.error === "DeviceNotRegistered" && token) {
        tokens.delete(token);
        removedInvalidToken = true;
      }
    });

    if (removedInvalidToken) {
      await persistPatrolPushTokens();
    }
  } catch (error) {
    app.log.warn({ unitId, error }, "Expo push send request failed");
  }
};

const clearReassignmentTimer = (reportId: string) => {
  const existingTimer = reassignmentTimers.get(reportId);
  if (existingTimer) {
    clearTimeout(existingTimer);
    reassignmentTimers.delete(reportId);
  }
};

const scheduleReassignment = (reportId: string) => {
  clearReassignmentTimer(reportId);
  const timer = setTimeout(() => {
    const report = reports.find((item) => item.id === reportId);
    if (!report || report.status !== "assigned") {
      return;
    }

    const currentUnit = patrolUnits.find((unit) => unit.id === report.assignedUnitId);
    if (currentUnit) {
      currentUnit.isAvailable = true;
      currentUnit.activeReportId = null;
      void persistPatrolUnits();
      broadcastPatrolUnitsUpdated();
    }

    const reassignedUnit = assignNearestPatrol(report);
    if (!reassignedUnit) {
      report.assignedUnitId = null;
      report.status = "submitted";
      broadcast("report_pending_dispatch", report);
      void persistReports();
      return;
    }

    broadcast("report_reassigned", {
      reportId: report.id,
      unitId: reassignedUnit.id,
      unitLabel: reassignedUnit.label
    });
    void sendPushToUnit(
      reassignedUnit.id,
      "Пренасочен сигнал",
      `Тел: ${report.phone} | ${report.lat.toFixed(4)}, ${report.lng.toFixed(4)}`,
      {
        reportId: report.id,
        event: "report_reassigned",
        phone: report.phone,
        lat: String(report.lat),
        lng: String(report.lng)
      }
    );
    broadcast("report_updated", report);
    void persistReports();
    scheduleReassignment(report.id);
  }, ASSIGNMENT_TIMEOUT_MS);

  reassignmentTimers.set(reportId, timer);
};

const assignNearestPatrol = (report: ReportRecord) => {
  const candidate = patrolUnits
    .filter((unit) => !report.assignmentAttempts.includes(unit.id) && isUnitAssignable(unit))
    .map((unit) => ({
      unit,
      distance: haversineMeters(report.lat, report.lng, unit.lat, unit.lng)
    }))
    .sort((a, b) => a.distance - b.distance)[0];

  if (!candidate) {
    return null;
  }

  candidate.unit.isAvailable = false;
  candidate.unit.activeReportId = report.id;
  report.assignedUnitId = candidate.unit.id;
  report.status = "assigned";
  report.assignmentAttempts.push(candidate.unit.id);
  void persistPatrolUnits();
  broadcastPatrolUnitsUpdated();

  return candidate.unit;
};

app.get("/health", async () => ({ ok: true }));

app.get("/monitor/patrol", async (_request, reply) => {
  const html = `<!doctype html>
<html lang="bg">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Signal Patrol Live Map</title>
    <link
      rel="stylesheet"
      href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
      integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY="
      crossorigin=""
    />
    <style>
      :root {
        --panel: rgba(255, 255, 255, 0.82);
        --ink: #1f2b38;
        --muted: #5f6f81;
        --ok: #11823b;
        --busy: #c57606;
        --off: #9aa7b5;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: "Manrope", "Segoe UI", sans-serif;
        color: var(--ink);
        background:
          radial-gradient(circle at 15% 12%, #d0ecff 0%, transparent 38%),
          radial-gradient(circle at 85% 18%, #ffe4c6 0%, transparent 34%),
          linear-gradient(160deg, #f9f7f2 0%, #edf3fb 100%);
      }
      .shell {
        width: min(1120px, 96vw);
        margin: 20px auto;
        display: grid;
        gap: 14px;
      }
      .hero {
        background: var(--panel);
        border: 1px solid rgba(31, 43, 56, 0.08);
        backdrop-filter: blur(8px);
        border-radius: 18px;
        padding: 14px 18px;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .title {
        margin: 0;
        font-size: clamp(1.1rem, 2.7vw, 1.9rem);
        letter-spacing: 0.02em;
      }
      .meta {
        margin-top: 4px;
        color: var(--muted);
        font-size: 0.9rem;
      }
      .chips {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      .chip {
        border-radius: 999px;
        padding: 6px 11px;
        font-size: 0.82rem;
        font-weight: 700;
        border: 1px solid rgba(31, 43, 56, 0.15);
        background: #fff;
      }
      .ok { color: var(--ok); }
      .busy { color: var(--busy); }
      .off { color: var(--off); }
      .legend {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
        font-size: 0.8rem;
        color: var(--muted);
      }
      .legend-dot {
        display: inline-block;
        width: 10px;
        height: 10px;
        border-radius: 3px;
        margin-right: 6px;
      }
      .map-wrap {
        overflow: hidden;
        border-radius: 18px;
        border: 1px solid rgba(31, 43, 56, 0.1);
        background: #e8eef5;
      }
      #map {
        width: 100%;
        height: min(74vh, 760px);
      }
      .list {
        background: var(--panel);
        border: 1px solid rgba(31, 43, 56, 0.08);
        backdrop-filter: blur(8px);
        border-radius: 18px;
        padding: 10px;
        display: grid;
        gap: 8px;
      }
      .row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        border: 1px solid rgba(31, 43, 56, 0.12);
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.88);
        padding: 10px 12px;
      }
      .row strong { font-size: 0.96rem; }
      .small { font-size: 0.84rem; color: var(--muted); }
      @media (max-width: 760px) {
        .hero { flex-direction: column; align-items: flex-start; gap: 8px; }
        #map { height: 56vh; }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <section class="hero">
        <div>
          <h1 class="title">Signal Patrol Live Map</h1>
          <div class="meta" id="last-update">Чакаме първи данни...</div>
          <div class="legend">
            <span><i class="legend-dot" style="background:#2f80ed"></i>submitted</span>
            <span><i class="legend-dot" style="background:#f4a300"></i>assigned</span>
            <span><i class="legend-dot" style="background:#8b5cf6"></i>accepted</span>
            <span><i class="legend-dot" style="background:#e63946"></i>on_site</span>
          </div>
        </div>
        <div class="chips">
          <span class="chip ok" id="count-available">Свободни: 0</span>
          <span class="chip busy" id="count-busy">Заети: 0</span>
          <span class="chip off" id="count-offline">Офлайн: 0</span>
          <span class="chip" id="count-incidents">Активни инциденти: 0</span>
        </div>
      </section>
      <section class="map-wrap"><div id="map"></div></section>
      <section class="list" id="units-list"></section>
    </main>
    <script
      src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
      integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo="
      crossorigin=""
    ></script>
    <script>
      const map = L.map("map", { zoomControl: true }).setView([42.6977, 23.3219], 12);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap contributors"
      }).addTo(map);

      const patrolLayer = L.layerGroup().addTo(map);
      const incidentLayer = L.layerGroup().addTo(map);
      L.control.layers(null, { "Патрули": patrolLayer, "Инциденти": incidentLayer }, { collapsed: false }).addTo(map);

      const unitMarkers = new Map();
      const incidentMarkers = new Map();
      const viewportPoints = [];
      let hasFitted = false;

      const lastUpdateEl = document.getElementById("last-update");
      const listEl = document.getElementById("units-list");
      const countAvailableEl = document.getElementById("count-available");
      const countBusyEl = document.getElementById("count-busy");
      const countOfflineEl = document.getElementById("count-offline");
      const countIncidentsEl = document.getElementById("count-incidents");

      const incidentColor = {
        submitted: "#2f80ed",
        assigned: "#f4a300",
        accepted: "#8b5cf6",
        on_site: "#e63946"
      };

      const statusText = (unit) => {
        if (!unit.active || !unit.reachable) return "offline";
        return unit.isAvailable ? "available" : "busy";
      };

      const patrolMarkerColor = (unit) => {
        const status = statusText(unit);
        if (status === "available") return "#11823b";
        if (status === "busy") return "#c57606";
        return "#8a98a6";
      };

      const patrolIconHtml = (color) =>
        '<span style="display:inline-block;width:18px;height:18px;border-radius:50%;background:' +
        color +
        ';border:2px solid white;box-shadow:0 2px 8px rgba(0,0,0,.25)"></span>';

      const incidentIconHtml = (status) => {
        const color = incidentColor[status] || "#2f80ed";
        if (status === "assigned") {
          return '<span style="display:inline-block;width:14px;height:14px;background:' + color + ';transform:rotate(45deg);border:2px solid white;box-shadow:0 2px 6px rgba(0,0,0,.25)"></span>';
        }
        if (status === "submitted") {
          return '<span style="display:inline-block;width:14px;height:14px;background:' + color + ';border-radius:3px;border:2px solid white;box-shadow:0 2px 6px rgba(0,0,0,.25)"></span>';
        }
        if (status === "accepted") {
          return '<span style="display:inline-block;width:16px;height:16px;background:' + color + ';border-radius:50%;border:3px solid white;box-shadow:0 2px 6px rgba(0,0,0,.25)"></span>';
        }
        return '<span style="display:inline-block;width:18px;height:18px;background:' + color + ';border-radius:50%;border:3px solid white;box-shadow:0 0 0 4px rgba(230,57,70,.25),0 2px 8px rgba(0,0,0,.25)"></span>';
      };

      const fitViewport = () => {
        if (hasFitted || viewportPoints.length === 0) return;
        map.fitBounds(viewportPoints, { padding: [32, 32], maxZoom: 15 });
        hasFitted = true;
      };

      const renderUnits = (units) => {
        const normalized = Array.isArray(units) ? units : [];
        const seenIds = new Set(normalized.map((unit) => unit.id));

        for (const [unitId, marker] of unitMarkers.entries()) {
          if (!seenIds.has(unitId)) {
            patrolLayer.removeLayer(marker);
            unitMarkers.delete(unitId);
          }
        }

        let available = 0;
        let busy = 0;
        let offline = 0;

        normalized.forEach((unit) => {
          const status = statusText(unit);
          if (status === "available") available += 1;
          else if (status === "busy") busy += 1;
          else offline += 1;

          const ll = [unit.lat, unit.lng];
          viewportPoints.push(ll);

          const popup =
            '<strong>' + unit.label + '</strong><br/>' +
            'id: ' + unit.id + '<br/>' +
            'status: ' + status + '<br/>' +
            'last seen: ' + new Date(unit.lastSeenAt).toLocaleString();

          const existing = unitMarkers.get(unit.id);
          if (existing) {
            existing.setLatLng(ll);
            existing.setIcon(L.divIcon({ className: "", html: patrolIconHtml(patrolMarkerColor(unit)), iconSize: [18, 18], iconAnchor: [9, 9] }));
            existing.bindPopup(popup);
          } else {
            const marker = L.marker(ll, {
              icon: L.divIcon({ className: "", html: patrolIconHtml(patrolMarkerColor(unit)), iconSize: [18, 18], iconAnchor: [9, 9] })
            }).addTo(patrolLayer);
            marker.bindPopup(popup);
            unitMarkers.set(unit.id, marker);
          }
        });

        countAvailableEl.textContent = 'Свободни: ' + available;
        countBusyEl.textContent = 'Заети: ' + busy;
        countOfflineEl.textContent = 'Офлайн: ' + offline;

        listEl.innerHTML = normalized
          .sort((a, b) => a.label.localeCompare(b.label))
          .map((unit) => {
            const status = statusText(unit);
            return (
              '<article class="row">' +
              '<div><strong>' + unit.label + '</strong><div class="small">' + unit.id + ' | ' + unit.platform + '</div></div>' +
              '<div class="small">' + status + ' | ' + new Date(unit.lastSeenAt).toLocaleTimeString() + '</div>' +
              '</article>'
            );
          })
          .join("");

        fitViewport();
        lastUpdateEl.textContent = 'Обновено: ' + new Date().toLocaleTimeString();
      };

      const renderIncidents = (incidents) => {
        const normalized = Array.isArray(incidents) ? incidents : [];
        const seenIds = new Set(normalized.map((item) => item.id));

        for (const [incidentId, marker] of incidentMarkers.entries()) {
          if (!seenIds.has(incidentId)) {
            incidentLayer.removeLayer(marker);
            incidentMarkers.delete(incidentId);
          }
        }

        normalized.forEach((incident) => {
          const ll = [incident.lat, incident.lng];
          viewportPoints.push(ll);

          const popup =
            '<strong>Инцидент</strong><br/>' +
            'id: ' + incident.id + '<br/>' +
            'status: ' + incident.status + '<br/>' +
            'assigned: ' + (incident.assignedUnitId || 'none');

          const existing = incidentMarkers.get(incident.id);
          if (existing) {
            existing.setLatLng(ll);
            existing.setIcon(L.divIcon({ className: "", html: incidentIconHtml(incident.status), iconSize: [18, 18], iconAnchor: [9, 9] }));
            existing.bindPopup(popup);
          } else {
            const marker = L.marker(ll, {
              icon: L.divIcon({ className: "", html: incidentIconHtml(incident.status), iconSize: [18, 18], iconAnchor: [9, 9] })
            }).addTo(incidentLayer);
            marker.bindPopup(popup);
            incidentMarkers.set(incident.id, marker);
          }
        });

        countIncidentsEl.textContent = 'Активни инциденти: ' + normalized.length;
        fitViewport();
      };

      const loadUnits = async () => {
        const response = await fetch('/patrol/units/live');
        const data = await response.json();
        renderUnits(data);
      };

      const loadIncidents = async () => {
        const response = await fetch('/monitor/incidents/active');
        const data = await response.json();
        renderIncidents(data);
      };

      const loadAll = async () => {
        try {
          await Promise.all([loadUnits(), loadIncidents()]);
        } catch (error) {
          console.error('Load failed', error);
        }
      };

      const connectWs = () => {
        const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const ws = new WebSocket(protocol + '://' + window.location.host + '/ws/patrol');

        ws.onmessage = (event) => {
          try {
            const payload = JSON.parse(event.data);
            if (payload.type === 'patrol_units_updated') {
              renderUnits(payload.data);
              return;
            }
            if (payload.type && payload.type.startsWith('report_')) {
              void loadIncidents();
            }
          } catch (error) {
            console.error('WS parse error', error);
          }
        };

        ws.onclose = () => {
          setTimeout(connectWs, 1500);
        };
      };

      loadAll();
      connectWs();
      setInterval(loadAll, 15000);
    </script>
  </body>
</html>`;

  return reply.type("text/html; charset=utf-8").send(html);
});

app.post("/patrol/register", async (request, reply) => {
  const body = z
    .object({
      deviceId: z.string().min(6),
      platform: z.enum(["android", "ios"]).default("android"),
      lat: z.number(),
      lng: z.number(),
      token: z.string().min(10).optional()
    })
    .parse(request.body);

  const unit = upsertPatrolUnit({
    deviceId: body.deviceId,
    platform: body.platform,
    lat: body.lat,
    lng: body.lng
  });

  if (body.token) {
    if (!isExpoPushToken(body.token)) {
      return reply.code(400).send({ error: "Invalid Expo push token" });
    }
    const unitTokens = patrolPushTokens.get(unit.id) ?? new Set<string>();
    unitTokens.add(body.token);
    patrolPushTokens.set(unit.id, unitTokens);
    await persistPatrolPushTokens();
  }

  await persistPatrolUnits();
  broadcastPatrolUnitsUpdated();
  return {
    ok: true,
    unitId: unit.id,
    label: unit.label,
    lat: unit.lat,
    lng: unit.lng
  };
});

app.post("/patrol/units/:unitId/heartbeat", async (request, reply) => {
  const params = z.object({ unitId: z.string() }).parse(request.params);
  const body = z
    .object({
      lat: z.number(),
      lng: z.number()
    })
    .parse(request.body);

  const unit = getPatrolUnitById(params.unitId);
  if (!unit) {
    return reply.code(404).send({ error: "Patrol unit not found" });
  }

  unit.lat = body.lat;
  unit.lng = body.lng;
  unit.lastSeenAt = new Date().toISOString();
  await persistPatrolUnits();
  broadcastPatrolUnitsUpdated();
  return { ok: true };
});

app.post("/patrol/units/:unitId/push-token", async (request, reply) => {
  const params = z.object({ unitId: z.string() }).parse(request.params);
  const body = z
    .object({
      token: z.string().min(10),
      platform: z.enum(["android", "ios"]).default("android")
    })
    .parse(request.body);

  if (!isExpoPushToken(body.token)) {
    return reply.code(400).send({ error: "Invalid Expo push token" });
  }

  const unitTokens = patrolPushTokens.get(params.unitId) ?? new Set<string>();
  unitTokens.add(body.token);
  patrolPushTokens.set(params.unitId, unitTokens);

  const fallbackUnit = getPatrolUnitById(params.unitId);
  if (!fallbackUnit) {
    patrolUnits.push({
      id: params.unitId,
      label: params.unitId,
      deviceId: params.unitId,
      platform: body.platform,
      lat: 42.6977,
      lng: 23.3219,
      lastSeenAt: new Date().toISOString(),
      isAvailable: true,
      activeReportId: null
    });
    await persistPatrolUnits();
  }

  await persistPatrolPushTokens();
  broadcastPatrolUnitsUpdated();

  return { ok: true, count: unitTokens.size };
});

app.get("/patrol/units/live", async () => {
  return getPatrolUnitsSnapshot();
});

app.get("/patrol/units/:unitId/push-status", async (request) => {
  const params = z.object({ unitId: z.string() }).parse(request.params);
  const unitTokens = patrolPushTokens.get(params.unitId) ?? new Set<string>();
  const unit = getPatrolUnitById(params.unitId);

  return {
    unitId: params.unitId,
    tokenCount: unitTokens.size,
    hasTokens: unitTokens.size > 0,
    reachable: unitTokens.size > 0,
    active: Boolean(unit && isUnitActiveRecently(unit)),
    label: unit?.label
  };
});

app.get("/patrol/incidents/live", async (request) => {
  const query = z
    .object({
      unitId: z.string().optional()
    })
    .parse(request.query ?? {});

  return reports
    .filter((report) => {
      if (!query.unitId) return true;
      return report.assignedUnitId === query.unitId;
    })
    .slice(-20)
    .reverse();
});

app.get("/monitor/incidents/active", async () => {
  return reports.filter((report) => report.status !== "closed").reverse();
});

app.post("/reports", async (request, reply) => {
  const payloadSchema = z
    .object({
      phone: z.string().min(8),
      photoUrl: z.string().url().optional(),
      photoBase64: z.string().min(100).max(8_000_000).optional(),
      lat: z.number(),
      lng: z.number(),
      gpsAccuracyM: z.number().max(250),
      capturedAtDevice: z.string().datetime()
    })
    .refine((payload) => Boolean(payload.photoUrl || payload.photoBase64), {
      message: "photoUrl or photoBase64 is required"
    });

  const parsed = payloadSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "Invalid payload", details: parsed.error.issues });
  }

  const photoUrl = parsed.data.photoUrl ?? `data:image/jpeg;base64,${parsed.data.photoBase64}`;

  const report = {
    id: crypto.randomUUID(),
    phone: parsed.data.phone,
    photoUrl,
    lat: parsed.data.lat,
    lng: parsed.data.lng,
    gpsAccuracyM: parsed.data.gpsAccuracyM,
    capturedAtDevice: parsed.data.capturedAtDevice,
    receivedAtServer: new Date().toISOString(),
    status: "submitted" as const,
    assignedUnitId: null,
    assignmentAttempts: [],
    acceptedAt: null,
    arrivedAt: null,
    closedAt: null
  };

  reports.push(report);
  await persistReports();
  const assignedUnit = assignNearestPatrol(report);

  broadcast("report_created", report);
  if (assignedUnit) {
    broadcast("report_assigned", {
      reportId: report.id,
      unitId: assignedUnit.id,
      unitLabel: assignedUnit.label
    });
    void sendPushToUnit(
      assignedUnit.id,
      "Нов сигнал",
      `Тел: ${report.phone} | ${report.lat.toFixed(4)}, ${report.lng.toFixed(4)}`,
      {
        reportId: report.id,
        event: "report_assigned",
        phone: report.phone,
        lat: String(report.lat),
        lng: String(report.lng)
      }
    );
    scheduleReassignment(report.id);
    await persistReports();
  }

  return reply.code(201).send(report);
});

app.post("/patrol/incidents/:id/accept", async (request, reply) => {
  const params = z.object({ id: z.string() }).parse(request.params);
  const body = z.object({ unitId: z.string() }).parse(request.body);

  const report = reports.find((item) => item.id === params.id);
  if (!report) {
    return reply.code(404).send({ error: "Report not found" });
  }
  if (report.assignedUnitId !== body.unitId) {
    return reply.code(409).send({ error: "Report is assigned to another unit" });
  }

  report.status = "accepted";
  report.acceptedAt = new Date().toISOString();
  clearReassignmentTimer(report.id);
  broadcast("report_updated", report);
  await persistReports();
  return { ok: true, report };
});

app.post("/patrol/incidents/:id/arrived", async (request, reply) => {
  const params = z.object({ id: z.string() }).parse(request.params);
  const body = z.object({ unitId: z.string() }).parse(request.body);

  const report = reports.find((item) => item.id === params.id);
  if (!report) {
    return reply.code(404).send({ error: "Report not found" });
  }
  if (report.assignedUnitId !== body.unitId) {
    return reply.code(409).send({ error: "Report is assigned to another unit" });
  }

  report.status = "on_site";
  report.arrivedAt = new Date().toISOString();
  broadcast("report_updated", report);
  await persistReports();
  return { ok: true, report };
});

app.post("/patrol/incidents/:id/close", async (request, reply) => {
  const params = z.object({ id: z.string() }).parse(request.params);
  const body = z.object({ unitId: z.string() }).parse(request.body);

  const report = reports.find((item) => item.id === params.id);
  if (!report) {
    return reply.code(404).send({ error: "Report not found" });
  }
  if (report.assignedUnitId !== body.unitId) {
    return reply.code(409).send({ error: "Report is assigned to another unit" });
  }

  report.status = "closed";
  report.closedAt = new Date().toISOString();
  clearReassignmentTimer(report.id);
  const patrolUnit = patrolUnits.find((unit) => unit.id === body.unitId);
  if (patrolUnit) {
    patrolUnit.isAvailable = true;
    patrolUnit.activeReportId = null;
    patrolUnit.lastSeenAt = new Date().toISOString();
    await persistPatrolUnits();
    broadcastPatrolUnitsUpdated();
  }

  broadcast("report_updated", report);
  await persistReports();
  return { ok: true, report };
});

app.get("/reports/:id", async (request, reply) => {
  const params = z.object({ id: z.string() }).parse(request.params);
  const report = reports.find((item) => item.id === params.id);

  if (!report) {
    return reply.code(404).send({ error: "Report not found" });
  }

  return report;
});

app.get("/ws/patrol", { websocket: true }, (socket) => {
  clients.add(socket);
  socket.send(
    JSON.stringify({
      type: "patrol_units_updated",
      data: getPatrolUnitsSnapshot()
    })
  );
  socket.on("close", () => clients.delete(socket));
});

const port = Number(process.env.PORT || 4000);
await loadPatrolUnits();
await loadPatrolPushTokens();
await loadReports();
await app.listen({ port, host: "0.0.0.0" });
