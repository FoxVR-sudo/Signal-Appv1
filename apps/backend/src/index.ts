import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";

type ReportStatus =
  | "submitted"
  | "assigned"
  | "accepted"
  | "on_site"
  | "closed"
  | "validated"
  | "rejected";

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
  validatedAt: string | null;
  rejectedAt: string | null;
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

type CitizenHistoryEntry = {
  id: string;
  submittedAt: string;
  status: ReportStatus;
  assignedUnitId: string | null;
  verified: boolean;
  verifiedAt: string | null;
};

type RewardLeaderboardEntry = {
  rank: number;
  phone: string;
  submittedCount: number;
  verifiedCount: number;
  latestSubmittedAt: string;
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
const PATROL_ACTIVE_WINDOW_MS = 120_000;
const MONTHLY_REWARD_VERIFIED_TARGET = 3;

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

const toMonthKey = (value: string) => {
  const date = new Date(value);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
};

const isReportVerified = (report: ReportRecord) =>
  Boolean(report.validatedAt || report.arrivedAt || report.closedAt);
const isReportAccepted = (report: ReportRecord) =>
  Boolean(report.acceptedAt || report.arrivedAt || report.closedAt);

const toCitizenHistoryEntry = (report: ReportRecord): CitizenHistoryEntry => ({
  id: report.id,
  submittedAt: report.receivedAtServer,
  status: report.status,
  assignedUnitId: report.assignedUnitId,
  verified: isReportVerified(report),
  verifiedAt: report.validatedAt ?? report.arrivedAt ?? report.closedAt
});

const buildMonthlyLeaderboard = (monthKey: string, limit?: number) => {
  const grouped = new Map<string, { submittedCount: number; verifiedCount: number; latestSubmittedAt: string }>();

  for (const report of reports) {
    if (toMonthKey(report.receivedAtServer) !== monthKey) {
      continue;
    }

    const phone = normalizePhone(report.phone);
    const current = grouped.get(phone) ?? {
      submittedCount: 0,
      verifiedCount: 0,
      latestSubmittedAt: report.receivedAtServer
    };

    current.submittedCount += 1;
    if (isReportVerified(report)) {
      current.verifiedCount += 1;
    }
    if (new Date(report.receivedAtServer).getTime() > new Date(current.latestSubmittedAt).getTime()) {
      current.latestSubmittedAt = report.receivedAtServer;
    }

    grouped.set(phone, current);
  }

  return [...grouped.entries()]
    .map(([phone, stats]) => ({ phone, ...stats }))
    .sort((left, right) => {
      if (right.verifiedCount !== left.verifiedCount) {
        return right.verifiedCount - left.verifiedCount;
      }
      if (right.submittedCount !== left.submittedCount) {
        return right.submittedCount - left.submittedCount;
      }
      return new Date(right.latestSubmittedAt).getTime() - new Date(left.latestSubmittedAt).getTime();
    })
    .slice(0, limit ?? Number.MAX_SAFE_INTEGER)
    .map((entry, index) => ({ rank: index + 1, ...entry } satisfies RewardLeaderboardEntry));
};

const buildCitizenRewardsSummary = (phone: string, monthKey: string) => {
  const normalizedPhone = normalizePhone(phone);
  const allByPhone = reports.filter((report) => normalizePhone(report.phone) === normalizedPhone);
  const monthlyReports = allByPhone.filter((report) => toMonthKey(report.receivedAtServer) === monthKey);
  const verifiedCount = monthlyReports.filter(isReportVerified).length;
  const acceptedCount = monthlyReports.filter(isReportAccepted).length;
  const leaderboard = buildMonthlyLeaderboard(monthKey);
  const leaderboardRank = leaderboard.find((entry) => entry.phone === normalizedPhone)?.rank ?? null;
  const participantCount = leaderboard.length;

  const monthlyParticipantStats = leaderboard.map((entry) => {
    const participantReports = reports.filter(
      (report) => normalizePhone(report.phone) === entry.phone && toMonthKey(report.receivedAtServer) === monthKey
    );
    return {
      submittedCount: participantReports.length,
      acceptedCount: participantReports.filter(isReportAccepted).length
    };
  });

  const averageSubmittedCount =
    monthlyParticipantStats.length > 0
      ? monthlyParticipantStats.reduce((sum, item) => sum + item.submittedCount, 0) /
        monthlyParticipantStats.length
      : 0;

  const averageAcceptedCount =
    monthlyParticipantStats.length > 0
      ? monthlyParticipantStats.reduce((sum, item) => sum + item.acceptedCount, 0) /
        monthlyParticipantStats.length
      : 0;

  const acceptanceRate = monthlyReports.length ? acceptedCount / monthlyReports.length : 0;

  return {
    monthKey,
    submittedCount: monthlyReports.length,
    acceptedCount,
    acceptanceRate,
    participantCount,
    averageSubmittedCount,
    averageAcceptedCount,
    verifiedCount,
    eligibleForReward: verifiedCount >= MONTHLY_REWARD_VERIFIED_TARGET,
    targetVerifiedCount: MONTHLY_REWARD_VERIFIED_TARGET,
    remainingForReward: Math.max(0, MONTHLY_REWARD_VERIFIED_TARGET - verifiedCount),
    leaderboardRank
  };
};

const maskPhone = (phone: string) => {
  if (phone.length <= 4) {
    return phone;
  }
  const visiblePrefix = phone.slice(0, 3);
  const visibleSuffix = phone.slice(-2);
  return `${visiblePrefix}${"*".repeat(Math.max(2, phone.length - 5))}${visibleSuffix}`;
};

const requeueReportsAssignedToInvalidUnits = () => {
  let changed = false;

  for (const report of reports) {
    if (!report.assignedUnitId || report.status === "closed") {
      continue;
    }

    const assignedUnit = getPatrolUnitById(report.assignedUnitId);
    if (assignedUnit && isUnitReachable(report.assignedUnitId) && isUnitActiveRecently(assignedUnit)) {
      continue;
    }

    clearReassignmentTimer(report.id);
    report.assignedUnitId = null;
    report.status = "submitted";
    changed = true;
  }

  return changed;
};

const detachTokenFromOtherUnits = async (token: string, keepUnitId: string) => {
  let changed = false;
  const emptiedUnitIds = new Set<string>();

  for (const [unitId, tokens] of patrolPushTokens.entries()) {
    if (unitId === keepUnitId) {
      continue;
    }

    if (tokens.delete(token)) {
      changed = true;
      if (tokens.size === 0) {
        patrolPushTokens.delete(unitId);
        emptiedUnitIds.add(unitId);
      }
    }
  }

  if (!changed) {
    return false;
  }

  for (let index = patrolUnits.length - 1; index >= 0; index -= 1) {
    const unit = patrolUnits[index];
    if (unit.id === keepUnitId) {
      continue;
    }
    if (emptiedUnitIds.has(unit.id) && !unit.activeReportId) {
      patrolUnits.splice(index, 1);
    }
  }

  await persistPatrolPushTokens();
  await persistPatrolUnits();
  return true;
};

const assignPendingReports = async () => {
  let changed = false;

  for (const report of reports) {
    if (report.status !== "submitted" || report.assignedUnitId) {
      continue;
    }

    const assignedUnit = assignNearestPatrol(report);
    if (!assignedUnit) {
      continue;
    }

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
    changed = true;
  }

  if (changed) {
    await persistReports();
  }

  return changed;
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
      const assignedUnit = report.assignedUnitId ? getPatrolUnitById(report.assignedUnitId) : null;

      // If assigned unit is missing, unreachable, or stale, return incident to dispatch queue.
      if (
        report.assignedUnitId &&
        report.status !== "closed" &&
        (!assignedUnit || !isUnitReachable(report.assignedUnitId) || !isUnitActiveRecently(assignedUnit))
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
      .top-nav {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
        font-size: 0.9rem;
      }
      .top-nav a {
        text-decoration: none;
        color: #0b3d91;
        font-weight: 700;
        padding: 6px 10px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.9);
        border: 1px solid rgba(31, 43, 56, 0.12);
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
      <nav class="top-nav">
        <a href="/monitor/patrol">Патрули</a>
        <a href="/monitor/admin">Админ</a>
        <a href="/monitor/heatmap">Heatmap</a>
      </nav>
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

app.get("/monitor/admin", async (_request, reply) => {
  const html = `<!doctype html>
<html lang="bg">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Signal Admin Panel</title>
    <style>
      body {
        margin: 0;
        font-family: "Segoe UI", sans-serif;
        background: #f3f6fb;
        color: #1f2b38;
      }
      main {
        width: min(1200px, 96vw);
        margin: 20px auto;
        display: grid;
        gap: 14px;
      }
      .top-nav {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
      }
      .top-nav a {
        text-decoration: none;
        color: #0b3d91;
        font-weight: 700;
        padding: 6px 10px;
        border-radius: 999px;
        background: #fff;
        border: 1px solid rgba(31, 43, 56, 0.12);
      }
      .panel {
        background: #fff;
        border-radius: 14px;
        border: 1px solid #dce4ef;
        padding: 14px;
      }
      h1 { margin: 0; font-size: 1.4rem; }
      .filters { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 10px; }
      select, button {
        border-radius: 8px;
        border: 1px solid #cbd5e1;
        padding: 8px 12px;
        background: #fff;
      }
      table { width: 100%; border-collapse: collapse; }
      th, td { padding: 10px; border-bottom: 1px solid #eef2f7; text-align: left; font-size: 0.9rem; }
      th { color: #64748b; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.03em; }
      .action-btn { border-radius: 8px; padding: 6px 10px; border: none; cursor: pointer; font-weight: 700; }
      .approve { background: #dcfce7; color: #166534; }
      .reject { background: #fee2e2; color: #991b1b; }
      .status-pill { padding: 4px 8px; border-radius: 999px; background: #f1f5f9; font-size: 0.75rem; }
      .hint { margin: 8px 0 0; color: #64748b; font-size: 0.92rem; }
      .photo-btn {
        border: none;
        background: transparent;
        padding: 0;
        cursor: pointer;
        display: inline-flex;
        border-radius: 10px;
        overflow: hidden;
        box-shadow: 0 0 0 1px rgba(148, 163, 184, 0.3);
      }
      .photo-thumb {
        width: 72px;
        height: 72px;
        object-fit: cover;
        display: block;
        background: #e2e8f0;
      }
      .photo-modal {
        position: fixed;
        inset: 0;
        display: none;
        align-items: center;
        justify-content: center;
        background: rgba(15, 23, 42, 0.72);
        padding: 24px;
      }
      .photo-modal.open { display: flex; }
      .photo-modal-card {
        width: min(900px, 96vw);
        max-height: 92vh;
        overflow: auto;
        background: #fff;
        border-radius: 18px;
        padding: 18px;
        display: grid;
        gap: 12px;
      }
      .photo-modal-head {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: center;
      }
      .photo-modal-head h2 { margin: 0; font-size: 1.1rem; }
      .photo-modal img {
        width: 100%;
        max-height: 72vh;
        object-fit: contain;
        border-radius: 14px;
        background: #e2e8f0;
      }
      .meta-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 10px;
        font-size: 0.92rem;
      }
      .meta-grid strong { display: block; color: #475569; font-size: 0.8rem; margin-bottom: 4px; }
    </style>
  </head>
  <body>
    <main>
      <nav class="top-nav">
        <a href="/monitor/patrol">Патрули</a>
        <a href="/monitor/admin">Админ</a>
        <a href="/monitor/heatmap">Heatmap</a>
      </nav>
      <section class="panel">
        <h1>Админ панел</h1>
        <p class="hint">Всеки нов сигнал се подава директно към активен patrol app за приемане. Ако няма приемане, администраторът може да пренасочи сигнала ръчно след преглед на снимката.</p>
        <div class="filters">
          <label>
            Статус
            <select id="statusFilter">
              <option value="">Всички</option>
              <option value="pending">pending</option>
              <option value="submitted">submitted</option>
              <option value="assigned">assigned</option>
              <option value="accepted">accepted</option>
              <option value="on_site">on_site</option>
              <option value="closed">closed</option>
              <option value="validated">validated</option>
              <option value="rejected">rejected</option>
            </select>
          </label>
          <button id="refreshBtn">Обнови</button>
        </div>
      </section>
      <section class="panel">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Снимка</th>
              <th>Телефон</th>
              <th>Статус</th>
              <th>Получен</th>
              <th>Патрул</th>
              <th>Разпределяне</th>
              <th>Действия</th>
            </tr>
          </thead>
          <tbody id="reportsBody"></tbody>
        </table>
      </section>
    </main>
    <div id="photoModal" class="photo-modal" aria-hidden="true">
      <div class="photo-modal-card">
        <div class="photo-modal-head">
          <h2 id="photoModalTitle">Снимка на сигнал</h2>
          <button id="closePhotoModal">Затвори</button>
        </div>
        <img id="photoModalImage" alt="Снимка на сигнал" />
        <div id="photoMeta" class="meta-grid"></div>
      </div>
    </div>
    <script>
      const bodyEl = document.getElementById('reportsBody');
      const filterEl = document.getElementById('statusFilter');
      const refreshBtn = document.getElementById('refreshBtn');
      const photoModalEl = document.getElementById('photoModal');
      const closePhotoModalEl = document.getElementById('closePhotoModal');
      const photoModalImageEl = document.getElementById('photoModalImage');
      const photoModalTitleEl = document.getElementById('photoModalTitle');
      const photoMetaEl = document.getElementById('photoMeta');
      let unitsCache = [];

      const escapeHtml = (value) => String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

      const escapeAttribute = (value) => escapeHtml(value);

      const loadUnits = async () => {
        try {
          const response = await fetch('/patrol/units/live');
          unitsCache = await response.json();
        } catch {
          unitsCache = [];
        }
      };

      const buildUnitOptions = (selectedId) => {
        return unitsCache
          .map((unit) => {
            const selected = unit.id === selectedId ? 'selected' : '';
            const label = unit.label + ' (' + unit.id + ')';
            return '<option value="' + unit.id + '" ' + selected + '>' + label + '</option>';
          })
          .join('');
      };

      const toDisplayStatus = (report) => {
        if (!report.assignedUnitId && report.status === 'submitted') {
          return 'pending';
        }
        return report.status;
      };

      const load = async () => {
        const status = filterEl.value;
        const url = status ? '/monitor/admin/reports?status=' + status : '/monitor/admin/reports';
        await loadUnits();
        const response = await fetch(url);
        const payload = await response.json();

        bodyEl.innerHTML = payload.items.map((report) => {
          const displayStatus = toDisplayStatus(report);
          const statusPill = '<span class="status-pill">' + displayStatus + '</span>';
          const photoButton = report.photoUrl
            ? '<button class="photo-btn" type="button" data-action="preview-photo" data-id="' + report.id + '" data-photo-url="' + escapeAttribute(report.photoUrl) + '" data-phone="' + escapeAttribute(report.phone) + '" data-status="' + escapeAttribute(displayStatus) + '" data-received="' + escapeAttribute(new Date(report.receivedAtServer).toLocaleString('bg-BG')) + '" data-patrol="' + escapeAttribute(report.assignedUnitId || '-') + '"><img class="photo-thumb" src="' + escapeAttribute(report.photoUrl) + '" alt="Снимка за сигнал ' + escapeAttribute(report.id.slice(0, 8)) + '" /></button>'
            : '-';
          const actions = report.status === 'validated' || report.status === 'rejected'
            ? ''
            : '<button class="action-btn approve" data-id="' + report.id + '" data-action="validate">Потвърди</button>' +
              '<button class="action-btn reject" data-id="' + report.id + '" data-action="reject">Откажи</button>';
          const unitOptions = buildUnitOptions(report.assignedUnitId);
          const assignControls = unitsCache.length
            ? '<div style="display:flex;gap:6px;align-items:center">' +
                '<select data-role="unit" data-id="' + report.id + '">' + unitOptions + '</select>' +
                '<button class="action-btn approve" data-id="' + report.id + '" data-action="assign">Изпрати</button>' +
              '</div>'
            : '-';
          return (
            '<tr>' +
            '<td>' + report.id.slice(0, 8) + '</td>' +
            '<td>' + photoButton + '</td>' +
            '<td>' + report.phone + '</td>' +
            '<td>' + statusPill + '</td>' +
            '<td>' + new Date(report.receivedAtServer).toLocaleString('bg-BG') + '</td>' +
            '<td>' + (report.assignedUnitId || '-') + '</td>' +
            '<td>' + assignControls + '</td>' +
            '<td>' + actions + '</td>' +
            '</tr>'
          );
        }).join('');
      };

      bodyEl.addEventListener('click', async (event) => {
        const button = event.target.closest('button[data-action]');
        if (!button) return;
        const reportId = button.dataset.id;
        const action = button.dataset.action;
        if (action === 'preview-photo') {
          photoModalTitleEl.textContent = 'Сигнал ' + reportId.slice(0, 8);
          photoModalImageEl.src = button.dataset.photoUrl || '';
          photoMetaEl.innerHTML = [
            ['Телефон', button.dataset.phone || '-'],
            ['Статус', button.dataset.status || '-'],
            ['Получен', button.dataset.received || '-'],
            ['Патрул', button.dataset.patrol || '-']
          ].map(([label, value]) => '<div><strong>' + label + '</strong>' + escapeHtml(value) + '</div>').join('');
          photoModalEl.classList.add('open');
          photoModalEl.setAttribute('aria-hidden', 'false');
          return;
        }
        if (action === 'assign') {
          const selector = bodyEl.querySelector('select[data-role="unit"][data-id="' + reportId + '"]');
          const unitId = selector ? selector.value : '';
          if (!unitId) return;
          await fetch('/admin/reports/' + reportId + '/assign', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ unitId })
          });
        } else {
          await fetch('/admin/reports/' + reportId + '/' + action, { method: 'POST' });
        }
        await load();
      });

      const closePhotoModal = () => {
        photoModalEl.classList.remove('open');
        photoModalEl.setAttribute('aria-hidden', 'true');
        photoModalImageEl.src = '';
        photoMetaEl.innerHTML = '';
      };

      closePhotoModalEl.addEventListener('click', closePhotoModal);
      photoModalEl.addEventListener('click', (event) => {
        if (event.target === photoModalEl) {
          closePhotoModal();
        }
      });
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && photoModalEl.classList.contains('open')) {
          closePhotoModal();
        }
      });

      refreshBtn.addEventListener('click', load);
      filterEl.addEventListener('change', load);
      load();
      setInterval(load, 15000);
    </script>
  </body>
</html>`;

  return reply.type("text/html; charset=utf-8").send(html);
});

app.get("/monitor/admin/reports", async (request) => {
  const query = z
    .object({
      status: z.string().optional(),
      limit: z.coerce.number().min(1).max(200).default(50)
    })
    .parse(request.query ?? {});

  const items = reports
    .filter((report) => {
      if (!query.status) {
        return true;
      }
      if (query.status === "pending") {
        return report.status === "submitted" && !report.assignedUnitId;
      }
      return report.status === query.status;
    })
    .sort((left, right) => new Date(right.receivedAtServer).getTime() - new Date(left.receivedAtServer).getTime())
    .slice(0, query.limit);

  return { items };
});

app.post("/admin/reports/:id/assign", async (request, reply) => {
  const params = z.object({ id: z.string() }).parse(request.params);
  const body = z.object({ unitId: z.string() }).parse(request.body ?? {});

  const report = reports.find((item) => item.id === params.id);
  if (!report) {
    return reply.code(404).send({ error: "Report not found" });
  }

  const targetUnit = getPatrolUnitById(body.unitId);
  if (!targetUnit) {
    return reply.code(404).send({ error: "Patrol unit not found" });
  }

  if (report.assignedUnitId && report.assignedUnitId !== targetUnit.id) {
    const previousUnit = getPatrolUnitById(report.assignedUnitId);
    if (previousUnit) {
      previousUnit.isAvailable = true;
      previousUnit.activeReportId = null;
    }
  }

  report.assignedUnitId = targetUnit.id;
  report.status = "assigned";
  report.assignmentAttempts.push(targetUnit.id);

  targetUnit.isAvailable = false;
  targetUnit.activeReportId = report.id;
  targetUnit.lastSeenAt = new Date().toISOString();
  await persistPatrolUnits();

  broadcast("report_assigned", {
    reportId: report.id,
    unitId: targetUnit.id,
    unitLabel: targetUnit.label
  });
  broadcast("report_updated", report);
  clearReassignmentTimer(report.id);
  scheduleReassignment(report.id);
  await persistReports();

  void sendPushToUnit(
    targetUnit.id,
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

  return { ok: true, report };
});

app.get("/monitor/heatmap", async (_request, reply) => {
  const html = `<!doctype html>
<html lang="bg">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Signal Heatmap</title>
    <link
      rel="stylesheet"
      href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
      integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY="
      crossorigin=""
    />
    <style>
      body { margin: 0; font-family: "Segoe UI", sans-serif; background: #f3f6fb; color: #1f2b38; }
      main { width: min(1200px, 96vw); margin: 20px auto; display: grid; gap: 12px; }
      .top-nav { display: flex; gap: 12px; flex-wrap: wrap; }
      .top-nav a { text-decoration: none; color: #0b3d91; font-weight: 700; padding: 6px 10px; border-radius: 999px; background: #fff; border: 1px solid rgba(31, 43, 56, 0.12); }
      .panel { background: #fff; border-radius: 14px; border: 1px solid #dce4ef; padding: 12px; }
      #map { width: 100%; height: 72vh; border-radius: 12px; }
    </style>
  </head>
  <body>
    <main>
      <nav class="top-nav">
        <a href="/monitor/patrol">Патрули</a>
        <a href="/monitor/admin">Админ</a>
        <a href="/monitor/heatmap">Heatmap</a>
      </nav>
      <section class="panel">
        <div id="map"></div>
      </section>
    </main>
    <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script>
    <script src="https://unpkg.com/leaflet.heat@0.2.0/dist/leaflet-heat.js"></script>
    <script>
      const map = L.map('map').setView([42.6977, 23.3219], 12);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors'
      }).addTo(map);

      const load = async () => {
        const response = await fetch('/monitor/heatmap/data?days=30');
        const payload = await response.json();
        const points = payload.points.map((item) => [item.lat, item.lng, item.weight]);
        const heat = L.heatLayer(points, { radius: 28, blur: 22, maxZoom: 16 });
        heat.addTo(map);
      };

      load();
    </script>
  </body>
</html>`;

  return reply.type("text/html; charset=utf-8").send(html);
});

app.get("/monitor/heatmap/data", async (request) => {
  const query = z
    .object({ days: z.coerce.number().min(1).max(365).default(30) })
    .parse(request.query ?? {});

  const cutoff = Date.now() - query.days * 24 * 60 * 60 * 1000;
  const points = reports
    .filter((report) => report.status !== "rejected")
    .filter((report) => new Date(report.receivedAtServer).getTime() >= cutoff)
    .map((report) => ({ lat: report.lat, lng: report.lng, weight: 1 }));

  return { points };
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

  let reportStateChanged = false;

  if (body.token) {
    if (!isExpoPushToken(body.token)) {
      return reply.code(400).send({ error: "Invalid Expo push token" });
    }

    if (await detachTokenFromOtherUnits(body.token, unit.id)) {
      reportStateChanged = requeueReportsAssignedToInvalidUnits() || reportStateChanged;
    }

    const unitTokens = patrolPushTokens.get(unit.id) ?? new Set<string>();
    unitTokens.add(body.token);
    patrolPushTokens.set(unit.id, unitTokens);
    await persistPatrolPushTokens();
  }

  await persistPatrolUnits();
  reportStateChanged = (await assignPendingReports()) || reportStateChanged;
  if (reportStateChanged) {
    await persistReports();
  }
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
  let reportStateChanged = false;

  if (await detachTokenFromOtherUnits(body.token, params.unitId)) {
    reportStateChanged = requeueReportsAssignedToInvalidUnits() || reportStateChanged;
  }

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
  reportStateChanged = (await assignPendingReports()) || reportStateChanged;
  if (reportStateChanged) {
    await persistReports();
  }
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
    .filter((report) => !["validated", "rejected"].includes(report.status))
    .filter((report) => {
      if (!query.unitId) return true;
      return report.assignedUnitId === query.unitId;
    })
    .slice(-20)
    .reverse();
});

app.get("/monitor/incidents/active", async () => {
  return reports
    .filter((report) => !["closed", "validated", "rejected"].includes(report.status))
    .reverse();
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
    phone: normalizePhone(parsed.data.phone),
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
    closedAt: null,
    validatedAt: null,
    rejectedAt: null
  };

  reports.push(report);
  await persistReports();
  broadcast("report_created", report);

  const assignedUnit = assignNearestPatrol(report);
  if (assignedUnit) {
    broadcast("report_assigned", {
      reportId: report.id,
      unitId: assignedUnit.id,
      unitLabel: assignedUnit.label
    });
    broadcast("report_updated", report);
    await persistReports();
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

app.post("/admin/reports/:id/validate", async (request, reply) => {
  const params = z.object({ id: z.string() }).parse(request.params);

  const report = reports.find((item) => item.id === params.id);
  if (!report) {
    return reply.code(404).send({ error: "Report not found" });
  }

  report.status = "validated";
  report.validatedAt = new Date().toISOString();
  report.rejectedAt = null;
  clearReassignmentTimer(report.id);

  const patrolUnit = report.assignedUnitId
    ? patrolUnits.find((unit) => unit.id === report.assignedUnitId)
    : null;
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

app.post("/admin/reports/:id/reject", async (request, reply) => {
  const params = z.object({ id: z.string() }).parse(request.params);

  const report = reports.find((item) => item.id === params.id);
  if (!report) {
    return reply.code(404).send({ error: "Report not found" });
  }

  report.status = "rejected";
  report.rejectedAt = new Date().toISOString();
  report.validatedAt = null;
  clearReassignmentTimer(report.id);

  const patrolUnit = report.assignedUnitId
    ? patrolUnits.find((unit) => unit.id === report.assignedUnitId)
    : null;
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

app.get("/citizen/history/:phone", async (request) => {
  const params = z.object({ phone: z.string().min(8) }).parse(request.params);
  const query = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional() }).parse(request.query ?? {});
  const phone = normalizePhone(params.phone);
  const monthKey = query.month ?? toMonthKey(new Date().toISOString());

  const history = reports
    .filter((report) => normalizePhone(report.phone) === phone)
    .sort((left, right) => new Date(right.receivedAtServer).getTime() - new Date(left.receivedAtServer).getTime())
    .slice(0, 25)
    .map(toCitizenHistoryEntry);

  return {
    phone,
    history,
    rewards: buildCitizenRewardsSummary(phone, monthKey),
    topLeaders: buildMonthlyLeaderboard(monthKey, 5).map((entry) => ({
      rank: entry.rank,
      phoneMasked: maskPhone(entry.phone),
      verifiedCount: entry.verifiedCount,
      submittedCount: entry.submittedCount
    }))
  };
});

app.get("/monitor/rewards/leaderboard", async (request) => {
  const query = z
    .object({
      month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
      limit: z.coerce.number().min(1).max(100).default(20)
    })
    .parse(request.query ?? {});

  const monthKey = query.month ?? toMonthKey(new Date().toISOString());
  return {
    monthKey,
    targetVerifiedCount: MONTHLY_REWARD_VERIFIED_TARGET,
    leaders: buildMonthlyLeaderboard(monthKey, query.limit)
  };
});

app.get("/monitor/rewards", async (_request, reply) => {
  const html = `<!doctype html>
<html lang="bg">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Signal Rewards Monitor</title>
    <style>
      body {
        margin: 0;
        font-family: "Segoe UI", sans-serif;
        background: linear-gradient(180deg, #f6f8fb 0%, #eef3f9 100%);
        color: #1f2b38;
      }
      main {
        width: min(980px, 94vw);
        margin: 24px auto;
        display: grid;
        gap: 16px;
      }
      .panel {
        background: rgba(255,255,255,.88);
        border: 1px solid rgba(31,43,56,.08);
        border-radius: 18px;
        padding: 18px;
      }
      h1, h2 { margin: 0 0 8px; }
      .muted { color: #66758a; }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      th, td {
        padding: 12px 10px;
        border-bottom: 1px solid #e5ebf3;
        text-align: left;
      }
      th { font-size: .82rem; color: #607086; text-transform: uppercase; letter-spacing: .04em; }
      .rank {
        display: inline-flex;
        width: 28px;
        height: 28px;
        border-radius: 999px;
        align-items: center;
        justify-content: center;
        background: #0b3d91;
        color: #fff;
        font-weight: 700;
      }
    </style>
  </head>
  <body>
    <main>
      <section class="panel">
        <h1>Месечни награди за потвърдени сигнали</h1>
        <p class="muted">Класацията включва само сигнали, потвърдени от патрул чрез достигане на място или приключване. Цел за награда: <strong>${MONTHLY_REWARD_VERIFIED_TARGET}</strong> потвърдени сигнала за месеца.</p>
      </section>
      <section class="panel">
        <h2 id="month-title">Текущ месец</h2>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Телефон</th>
              <th>Подадени</th>
              <th>Потвърдени</th>
              <th>Последен сигнал</th>
            </tr>
          </thead>
          <tbody id="leaders-body"></tbody>
        </table>
      </section>
    </main>
    <script>
      const bodyEl = document.getElementById('leaders-body');
      const monthTitleEl = document.getElementById('month-title');

      const load = async () => {
        const response = await fetch('/monitor/rewards/leaderboard');
        const payload = await response.json();
        monthTitleEl.textContent = 'Класация за ' + payload.monthKey;
        bodyEl.innerHTML = payload.leaders.map((entry) => (
          '<tr>' +
          '<td><span class="rank">' + entry.rank + '</span></td>' +
          '<td>' + entry.phone + '</td>' +
          '<td>' + entry.submittedCount + '</td>' +
          '<td>' + entry.verifiedCount + '</td>' +
          '<td>' + new Date(entry.latestSubmittedAt).toLocaleString('bg-BG') + '</td>' +
          '</tr>'
        )).join('');
      };

      void load();
    </script>
  </body>
</html>`;

  return reply.type("text/html; charset=utf-8").send(html);
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
