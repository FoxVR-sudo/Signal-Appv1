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
};

type PatrolUnit = {
  id: string;
  label: string;
  lat: number;
  lng: number;
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

const patrolUnits: PatrolUnit[] = [
  { id: "patrol-1", label: "Патрул 1", lat: 42.6977, lng: 23.3219, isAvailable: true, activeReportId: null },
  { id: "patrol-2", label: "Патрул 2", lat: 42.6900, lng: 23.3300, isAvailable: true, activeReportId: null }
];

const clients = new Set<import("ws").WebSocket>();
const reassignmentTimers = new Map<string, NodeJS.Timeout>();
const ASSIGNMENT_TIMEOUT_MS = 120_000;
const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const patrolPushTokens = new Map<string, Set<string>>();
const PUSH_TOKEN_STORE_DIR = path.join(process.cwd(), ".data");
const PUSH_TOKEN_STORE_PATH = path.join(PUSH_TOKEN_STORE_DIR, "patrol-push-tokens.json");

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
    }

    const reassignedUnit = assignNearestPatrol(report);
    if (!reassignedUnit) {
      report.assignedUnitId = null;
      report.status = "submitted";
      broadcast("report_pending_dispatch", report);
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
    scheduleReassignment(report.id);
  }, ASSIGNMENT_TIMEOUT_MS);

  reassignmentTimers.set(reportId, timer);
};

const assignNearestPatrol = (report: ReportRecord) => {
  const candidate = patrolUnits
    .filter((unit) => unit.isAvailable && !report.assignmentAttempts.includes(unit.id))
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

  return candidate.unit;
};

app.get("/health", async () => ({ ok: true }));

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
  await persistPatrolPushTokens();

  return { ok: true, count: unitTokens.size };
});

app.get("/patrol/units/:unitId/push-status", async (request) => {
  const params = z.object({ unitId: z.string() }).parse(request.params);
  const unitTokens = patrolPushTokens.get(params.unitId) ?? new Set<string>();

  return {
    unitId: params.unitId,
    tokenCount: unitTokens.size,
    hasTokens: unitTokens.size > 0
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
    assignmentAttempts: []
  };

  reports.push(report);
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
  clearReassignmentTimer(report.id);
  broadcast("report_updated", report);
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
  broadcast("report_updated", report);
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
  clearReassignmentTimer(report.id);
  const patrolUnit = patrolUnits.find((unit) => unit.id === body.unitId);
  if (patrolUnit) {
    patrolUnit.isAvailable = true;
    patrolUnit.activeReportId = null;
  }

  broadcast("report_updated", report);
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
  socket.on("close", () => clients.delete(socket));
});

const port = Number(process.env.PORT || 4000);
await loadPatrolPushTokens();
await app.listen({ port, host: "0.0.0.0" });
