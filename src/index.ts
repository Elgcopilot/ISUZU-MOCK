/**
 * src/index.ts
 * Racing Platform - combined REST + WebSocket mock server (port 4001).
 *
 * Fleet, drivers, and race-control thresholds are handled here directly using
 * the same db.CARS / db.DRIVERS data as the WebSocket channels, so data is
 * always in sync.  All other REST paths are proxied to Stoplight Prism on
 * port 4000 which reads openapi.yaml for the remaining endpoints.
 *
 * Frontend .env.local:
 *   API_BASE_URL=http://localhost:4001             <- this server (REST + WS)
 *   NEXT_PUBLIC_WS_ENDPOINT=http://localhost:4001  <- this server (WS)
 */

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { Server, type Socket } from "socket.io";
import * as db from "./data";

// ── REST helpers ─────────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function jsonResponse(
  res: ServerResponse,
  status: number,
  data: unknown,
): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
  res.end(body);
}

// API key → administration graphConfig key mapping.
// The frontend uses field names from DirectorGraphConfig; the engine uses
// internal MetricKey names — match the WS MetricKey names exactly.
const METRIC_MAP: Record<string, db.MetricKey> = {
  rpm: "rpm",
  speed: "speed",
  throttle: "throttle",
  lambda: "lambda",
  fuelPressure: "fuelPressure",
  airflow: "airflow",
  ignitionTiming: "ignitionTiming",
};

const CAMERA_STREAMS = {
  FRONT:
    "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4",
  COCKPIT:
    "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4",
  REAR: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4",
} as const;

type CameraView = keyof typeof CAMERA_STREAMS;

interface EngineeringLayoutItem {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface StoredEngineeringLayout {
  layout: EngineeringLayoutItem[];
  hiddenWidgets: string[];
  visualIdentityColor?: string; // HEX or RGB string
}

interface LayoutItem {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
  minW?: number;
  minH?: number;
  maxW?: number;
  maxH?: number;
}

interface SensorLayouts {
  POWERTRAIN?: LayoutItem[];
  CHASSIS?: LayoutItem[];
  AERO?: LayoutItem[];
  ELECTRONICS?: LayoutItem[];
}

interface Theme {
  primary: string;
  accent: string;
  accentGlow: string;
  brandGradientEnd: string;
}

interface StoredRaceControlLayout {
  mainLayout: LayoutItem[];
  sensorLayouts: SensorLayouts;
  theme: Theme;
}

interface RaceEvent {
  id: string;
  name: string;
  track: string;
  sessionType: "PRACTICE" | "QUALIFYING" | "RACE" | "TEST";
  scheduledAt: string;
  status: "upcoming" | "active" | "completed";
}

interface AdminUser {
  id: string;
  name: string;
  role: string;
  email: string;
  access: "Admin" | "Director" | "Engineer";
}

interface MockCredential {
  id: string;
  role: "ADMIN" | "DIRECTOR" | "ENGINEER";
  label: string;
  name: string;
  email: string;
  password: string;
  landingPage: string;
  notes: string;
  access: "Admin" | "Director" | "Engineer";
}

interface UserPermissions {
  raceControl: boolean;
  engineering: boolean;
  administration: boolean;
  directorThresholds: boolean;
}

interface MockJwtClaims {
  sub: string;
  name: string;
  email: string;
  role: MockCredential["role"];
  access: MockCredential["access"];
  permissions: UserPermissions;
  iat: number;
  exp: number;
  iss: string;
  aud: string;
}

interface Garage {
  id: string;
  name: string;
  location: string;
  teamId: string;
  assignedCarIds: number[];
}

type TaskStatus = "TODO" | "IN_PROGRESS" | "DONE";
type TaskPriority = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignee: string;
  dueDate?: string;
  attachment?: string;
}

type StoredFileType = "folder" | "csv" | "mp4" | "zip";
type RecordingStatus = "pending" | "processing" | "ready" | "error";
type RecordingSourcePage = "ENGINEERING" | "DIRECTOR";

interface StoredFileNode {
  id: string;
  parentId: string;
  name: string;
  type: StoredFileType;
  size?: string;
  date: string;
  downloadUrl?: string;
  recordingId?: string;
}

interface RecordingSession {
  id: string;
  vehicleId: number;
  sessionName: string;
  startDate: string;
  endDate: string;
  status: RecordingStatus;
  fileCount: number;
  createdAt: string;
  targetFolderId?: string;
  downloadUrl?: string;
  archiveFileName?: string;
  sourcePage?: RecordingSourcePage;
  requestedBy?: string;
}

interface InternalRecordingSession extends RecordingSession {
  sessionFolderId: string;
}

interface CreateRecordingRequestBody {
  vehicleId?: number;
  sessionName?: string;
  startDate?: string;
  endDate?: string;
  targetFolderId?: string;
  createFolderName?: string;
  sourcePage?: RecordingSourcePage;
  requestedBy?: string;
}

interface SeedRecordingFixture {
  id: string;
  vehicleId: number;
  sessionName: string;
  startDate: string;
  endDate: string;
  createdAt: string;
  targetFolderId: string;
  sourcePage: RecordingSourcePage;
  requestedBy: string;
  status: RecordingStatus;
}

const engineeringLayoutStore = new Map<string, StoredEngineeringLayout>();
const raceControlLayoutStore = new Map<string, StoredRaceControlLayout>();
const mockAuthEnabled = process.env.MOCK_AUTH_ENABLED !== "false";
const demoCredentialListingEnabled =
  process.env.ENABLE_DEMO_CREDENTIAL_LIST === "true" ||
  process.env.NODE_ENV !== "production";
const jwtIssuer = process.env.MOCK_JWT_ISSUER ?? "isuzu-racing-mock-auth";
const jwtAudience = process.env.MOCK_JWT_AUDIENCE ?? "racing-platform-fe";
const jwtTtlSeconds = Number(process.env.MOCK_JWT_TTL_SECONDS ?? 3600);
let directorRefreshRateHz = Number(process.env.DIRECTOR_REFRESH_RATE_HZ ?? 5);
const jwtSecret = randomBytes(32);
const mockCredentials: MockCredential[] = [
  {
    id: "user-admin-1",
    role: "ADMIN",
    label: "Platform Administrator",
    name: "Platform Administrator",
    email: "admin@isuzu.com",
    password: "Admin@123",
    landingPage: "/administration",
    notes: "Full mock access including Command Center and Settings.",
    access: "Admin",
  },
  {
    id: "user-director-1",
    role: "DIRECTOR",
    label: "Race Director",
    name: "Race Director",
    email: "director@isuzu.com",
    password: "Director@123",
    landingPage: "/overview-director",
    notes: "Use for race oversight and threshold review scenarios.",
    access: "Director",
  },
  {
    id: "user-engineer-1",
    role: "ENGINEER",
    label: "Trackside Engineer",
    name: "Trackside Engineer",
    email: "engineer@isuzu.com",
    password: "Engineer@123",
    landingPage: "/engineering",
    notes: "Use for telemetry and garage workflow scenarios.",
    access: "Engineer",
  },
  {
    id: "user-engineer-2",
    role: "ENGINEER",
    label: "Test Engineer",
    name: "Narin Chaisiri",
    email: "narin@isuzu.com",
    password: "Engineer@123",
    landingPage: "/engineering",
    notes: "Second engineer for mock login.",
    access: "Engineer",
  },
];
const eventsStore = new Map<string, RaceEvent>([
  [
    "event-buriram-active",
    {
      id: "event-buriram-active",
      name: "Buriram GT3 Series",
      track: "Buriram International Circuit",
      sessionType: "PRACTICE",
      scheduledAt: new Date().toISOString(),
      status: "active",
    },
  ],
]);
const adminUsersStore = new Map<string, AdminUser>([
  ...mockCredentials.map(
    (credential) =>
      [
        credential.id,
        {
          id: credential.id,
          name: credential.name,
          role: credential.label,
          email: credential.email,
          access: credential.access,
        },
      ] as const,
  ),
]);
const garagesStore = new Map<string, Garage>([
  [
    "garage-buriram-main",
    {
      id: "garage-buriram-main",
      name: "Main Pit Garage",
      location: "Buriram International Circuit",
      teamId: "isuzu-racing",
      assignedCarIds: db.CARS.map((car) => car.id),
    },
  ],
]);
const deleteFilePassword =
  process.env.FILE_DELETE_ADMIN_PASSWORD ?? "Admin@123";

interface AlertThreshold {
  id: string;
  metric: string;
  label: string;
  unit: string;
  warningValue: number;
  criticalValue: number;
}

const alertThresholdsStore: AlertThreshold[] = [
  // ── POWERTRAIN ──
  {
    id: "engineTemp",
    metric: "engineTemp",
    label: "Engine Temp",
    unit: "°C",
    warningValue: 105,
    criticalValue: 120,
  },
  {
    id: "oilPressure",
    metric: "oilPressure",
    label: "Engine Oil Pressure",
    unit: "bar",
    warningValue: 3.5,
    criticalValue: 2.5,
  },
  {
    id: "fuelPressure",
    metric: "fuelPressure",
    label: "Fuel Pressure",
    unit: "bar",
    warningValue: 1.5,
    criticalValue: 1.0,
  },
  {
    id: "fuelFlow",
    metric: "fuelFlow",
    label: "Fuel Flow Rate",
    unit: "kg/h",
    warningValue: 95,
    criticalValue: 105,
  },
  {
    id: "turboBoost",
    metric: "turboBoost",
    label: "Turbo Boost",
    unit: "bar",
    warningValue: 2.5,
    criticalValue: 2.8,
  },
  {
    id: "gearboxTemp",
    metric: "gearboxTemp",
    label: "Gearbox Temp",
    unit: "°C",
    warningValue: 115,
    criticalValue: 130,
  },
  {
    id: "exhaustTemp",
    metric: "exhaustTemp",
    label: "Exhaust Gas Temp",
    unit: "°C",
    warningValue: 880,
    criticalValue: 950,
  },
  {
    id: "coolantTemp",
    metric: "coolantTemp",
    label: "Coolant Temp",
    unit: "°C",
    warningValue: 105,
    criticalValue: 115,
  },
  // ── CHASSIS ──
  {
    id: "tireTemp",
    metric: "tireTemp",
    label: "Tire Temp",
    unit: "°C",
    warningValue: 110,
    criticalValue: 125,
  },
  {
    id: "tirePressure",
    metric: "tirePressure",
    label: "Tire Pressure",
    unit: "bar",
    warningValue: 1.0,
    criticalValue: 0.8,
  },
  {
    id: "brakePressure",
    metric: "brakePressure",
    label: "Brake Line Pressure",
    unit: "bar",
    warningValue: 50,
    criticalValue: 60,
  },
  // ── GENERAL ──
  {
    id: "fuelLevel",
    metric: "fuelLevel",
    label: "Fuel Low",
    unit: "L",
    warningValue: 15,
    criticalValue: 5,
  },
  {
    id: "rpm",
    metric: "rpm",
    label: "RPM High",
    unit: "RPM",
    warningValue: 10000,
    criticalValue: 11500,
  },
  {
    id: "speed",
    metric: "speed",
    label: "Speed High",
    unit: "km/h",
    warningValue: 220,
    criticalValue: 240,
  },
  {
    id: "suspensionTravel",
    metric: "suspensionTravel",
    label: "Suspension Travel",
    unit: "mm",
    warningValue: 148,
    criticalValue: 155,
  },
  // ── ELECTRONICS ──
  {
    id: "batteryVoltage",
    metric: "batteryVoltage",
    label: "Battery Voltage",
    unit: "V",
    warningValue: 12.1,
    criticalValue: 11.8,
  },
  {
    id: "telemetryLatency",
    metric: "telemetryLatency",
    label: "Telemetry Link",
    unit: "ms",
    warningValue: 45,
    criticalValue: 55,
  },
  {
    id: "gpsSats",
    metric: "gpsSats",
    label: "GPS Signal",
    unit: "Sats",
    warningValue: 9,
    criticalValue: 7,
  },
];

const filesStore = new Map<string, StoredFileNode>([
  [
    "event-1",
    {
      id: "event-1",
      parentId: "root",
      name: "Buriram GT3 Series",
      type: "folder",
      date: "2026-03-16T10:00:00Z",
    },
  ],
  [
    "event-2",
    {
      id: "event-2",
      parentId: "root",
      name: "Sepang Winter Test",
      type: "folder",
      date: "2026-03-12T09:00:00Z",
    },
  ],
  [
    "seed-summary-csv",
    {
      id: "seed-summary-csv",
      parentId: "event-1",
      name: "Session_Summary.csv",
      type: "csv",
      size: "2.4 MB",
      date: "2026-03-16T10:30:00Z",
      downloadUrl:
        "https://storage.example.com/files/session-summary.csv?signature=demo",
    },
  ],
  [
    "seed-front-cam",
    {
      id: "seed-front-cam",
      parentId: "event-1",
      name: "Front_Camera.mp4",
      type: "mp4",
      size: "135 MB",
      date: "2026-03-16T10:31:00Z",
      downloadUrl:
        "https://storage.example.com/files/front-camera.mp4?signature=demo",
    },
  ],
]);
const recordingsStore = new Map<string, InternalRecordingSession>();

function getTaskAssignableUsers(): AdminUser[] {
  return Array.from(adminUsersStore.values());
}

function resolveTaskAssignee(
  assignee: string | undefined,
  fallbackAssignee: string,
): string {
  const normalizedAssignee = assignee?.trim();
  if (!normalizedAssignee) {
    return fallbackAssignee;
  }

  const matchedUser = getTaskAssignableUsers().find(
    (user) => user.name.toLowerCase() === normalizedAssignee.toLowerCase(),
  );

  return matchedUser?.name ?? fallbackAssignee;
}

const tasksStore = new Map<string, Task>([
  [
    "task-1",
    {
      id: "task-1",
      title: "Check front wing angle",
      description: "Verify front wing angle before session 3 warmup lap.",
      status: "TODO",
      priority: "HIGH",
      assignee: "Trackside Engineer",
      dueDate: "2026-03-17T14:00:00Z",
    },
  ],
  [
    "task-2",
    {
      id: "task-2",
      title: "Replace FL brake pads",
      description:
        "Front-left brake temp exceeded threshold on lap 18. Schedule pad change.",
      status: "IN_PROGRESS",
      priority: "CRITICAL",
      assignee: "Platform Administrator",
      dueDate: "2026-03-17T12:30:00Z",
    },
  ],
  [
    "task-3",
    {
      id: "task-3",
      title: "Review tire pressure data",
      description:
        "Analyze tire pressure trends from last session for optimal cold-start strategy.",
      status: "DONE",
      priority: "MEDIUM",
      assignee: "Trackside Engineer",
    },
  ],
]);

const permissionsByRole: Record<MockCredential["role"], UserPermissions> = {
  ADMIN: {
    raceControl: true,
    engineering: true,
    administration: true,
    directorThresholds: true,
  },
  DIRECTOR: {
    raceControl: true,
    engineering: true,
    administration: false,
    directorThresholds: true,
  },
  ENGINEER: {
    raceControl: true,
    engineering: true,
    administration: false,
    directorThresholds: false,
  },
};

const accessByRole: Record<MockCredential["role"], MockCredential["access"]> = {
  ADMIN: "Admin",
  DIRECTOR: "Director",
  ENGINEER: "Engineer",
};

function inferAccessFromRole(role: string): AdminUser["access"] {
  const normalizedRole = role.trim().toUpperCase();
  if (normalizedRole.includes("ADMIN")) {
    return "Admin";
  }
  if (normalizedRole.includes("DIRECTOR")) {
    return "Director";
  }
  return "Engineer";
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function decodeBase64Url(value: string): string {
  const padding = (4 - (value.length % 4)) % 4;
  const normalized = `${value.replace(/-/g, "+").replace(/_/g, "/")}${"=".repeat(padding)}`;
  return Buffer.from(normalized, "base64").toString("utf8");
}

function signJwt(claims: MockJwtClaims): string {
  const header = encodeBase64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = encodeBase64Url(JSON.stringify(claims));
  const unsignedToken = `${header}.${payload}`;
  const signature = createHmac("sha256", jwtSecret)
    .update(unsignedToken)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${unsignedToken}.${signature}`;
}

function buildClaims(credential: MockCredential): MockJwtClaims {
  const iat = Math.floor(Date.now() / 1000);
  return {
    sub: credential.id,
    name: credential.name,
    email: credential.email,
    role: credential.role,
    access: accessByRole[credential.role],
    permissions: permissionsByRole[credential.role],
    iat,
    exp: iat + jwtTtlSeconds,
    iss: jwtIssuer,
    aud: jwtAudience,
  };
}

function verifyJwt(token: string): MockJwtClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }

  const [header, payload, signature] = parts;
  const expected = createHmac("sha256", jwtSecret)
    .update(`${header}.${payload}`)
    .digest();
  const received = Buffer.from(
    signature.replace(/-/g, "+").replace(/_/g, "/"),
    "base64",
  );

  if (
    expected.length !== received.length ||
    !timingSafeEqual(expected, received)
  ) {
    return null;
  }

  try {
    const claims = JSON.parse(decodeBase64Url(payload)) as MockJwtClaims;
    if (claims.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
}

function getBearerToken(req: IncomingMessage): string | null {
  const authorization = req.headers["authorization"];
  if (!authorization || Array.isArray(authorization)) {
    return null;
  }
  const [scheme, token] = authorization.split(" ");
  if (scheme !== "Bearer" || !token) {
    return null;
  }
  return token;
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now()}`;
}

function sanitizeFileName(value: string): string {
  const trimmed = value.trim();
  return trimmed.replace(/[^a-zA-Z0-9-_]+/g, "_") || "recording";
}

function sanitizeLabelSegment(
  value: string | undefined,
  fallback: string,
): string {
  const normalized = value?.trim();
  if (!normalized) {
    return fallback;
  }
  return normalized.replace(/[^a-zA-Z0-9-_]+/g, "_").toLowerCase();
}

function resolveRecordingStatus(
  session: InternalRecordingSession,
): RecordingStatus {
  if (session.status === "error") {
    return "error";
  }

  const elapsedMs = Date.now() - Date.parse(session.createdAt);
  return elapsedMs >= 1500 ? "ready" : "processing";
}

function buildRecordingArchiveUrl(
  recordingId: string,
  fileName: string,
): string {
  return `https://storage.example.com/recordings/${encodeURIComponent(fileName)}?recordingId=${encodeURIComponent(recordingId)}&signature=demo`;
}

function toPublicRecordingSession(
  session: InternalRecordingSession,
): RecordingSession {
  const status = resolveRecordingStatus(session);
  const downloadUrl =
    status === "ready" && session.archiveFileName
      ? buildRecordingArchiveUrl(session.id, session.archiveFileName)
      : undefined;

  return {
    ...session,
    status,
    downloadUrl,
  };
}

function toPublicFileNode(node: StoredFileNode): StoredFileNode {
  if (!node.recordingId) {
    return node;
  }

  const recording = recordingsStore.get(node.recordingId);
  if (!recording) {
    return node;
  }

  const publicSession = toPublicRecordingSession(recording);
  return {
    ...node,
    downloadUrl:
      node.type === "zip" && publicSession.status === "ready"
        ? publicSession.downloadUrl
        : node.downloadUrl,
  };
}

function collectDescendantIds(fileId: string): string[] {
  const directChildren = Array.from(filesStore.values())
    .filter((file) => file.parentId === fileId)
    .flatMap((file) => collectDescendantIds(file.id));

  return [fileId, ...directChildren];
}

function createRecordingSession(
  vehicleId: number,
  body: CreateRecordingRequestBody,
): RecordingSession | { error: { status: number; message: string } } {
  const sessionName = body.sessionName?.trim();
  const startDate = body.startDate?.trim();
  const endDate = body.endDate?.trim();
  const requestedTargetFolderId = body.targetFolderId?.trim() || "root";
  const createFolderName = body.createFolderName?.trim();
  const sourcePage = body.sourcePage ?? "ENGINEERING";
  const requestedBy = body.requestedBy?.trim() || "Unknown Operator";

  if (!sessionName || !startDate || !endDate) {
    return {
      error: {
        status: 400,
        message: "sessionName, startDate, and endDate are required.",
      },
    };
  }

  if (requestedTargetFolderId !== "root") {
    const targetFolder = filesStore.get(requestedTargetFolderId);
    if (!targetFolder || targetFolder.type !== "folder") {
      return {
        error: { status: 404, message: "Target folder not found." },
      };
    }
  }

  const createdAt = new Date().toISOString();
  let parentFolderId = requestedTargetFolderId;

  if (createFolderName) {
    const createdFolderId = createId("folder");
    filesStore.set(createdFolderId, {
      id: createdFolderId,
      parentId: requestedTargetFolderId,
      name: createFolderName,
      type: "folder",
      date: createdAt,
    });
    parentFolderId = createdFolderId;
  }

  const sessionId = createId("rec");
  const sessionFolderId = createId("rec-folder");
  const fileStem = [
    sanitizeLabelSegment(sourcePage, "engineering"),
    sanitizeLabelSegment(requestedBy, "operator"),
    sanitizeFileName(sessionName),
  ].join("_");
  const archiveFileName = `${fileStem}.zip`;
  const telemetryFileName = `${fileStem}_telemetry.csv`;

  filesStore.set(sessionFolderId, {
    id: sessionFolderId,
    parentId: parentFolderId,
    name: sessionName,
    type: "folder",
    date: createdAt,
    recordingId: sessionId,
  });

  [
    {
      id: createId("rec-csv"),
      name: telemetryFileName,
      type: "csv" as const,
      size: "4.2 MB",
    },
    {
      id: createId("rec-front"),
      name: `${fileStem}_front_camera.mp4`,
      type: "mp4" as const,
      size: "125 MB",
    },
    {
      id: createId("rec-cockpit"),
      name: `${fileStem}_cockpit_camera.mp4`,
      type: "mp4" as const,
      size: "126 MB",
    },
    {
      id: createId("rec-rear"),
      name: `${fileStem}_rear_camera.mp4`,
      type: "mp4" as const,
      size: "124 MB",
    },
    {
      id: createId("rec-zip"),
      name: archiveFileName,
      type: "zip" as const,
      size: "412 MB",
    },
  ].forEach((file) => {
    filesStore.set(file.id, {
      id: file.id,
      parentId: sessionFolderId,
      name: file.name,
      type: file.type,
      size: file.size,
      date: createdAt,
      recordingId: sessionId,
    });
  });

  const session: InternalRecordingSession = {
    id: sessionId,
    vehicleId,
    sessionName,
    startDate,
    endDate,
    status: "processing",
    fileCount: 5,
    createdAt,
    targetFolderId: parentFolderId,
    archiveFileName,
    sourcePage,
    requestedBy,
    sessionFolderId,
  };

  recordingsStore.set(session.id, session);
  return toPublicRecordingSession(session);
}

function seedRecordingFixture(fixture: SeedRecordingFixture): void {
  const fileStem = [
    sanitizeLabelSegment(fixture.sourcePage, "engineering"),
    sanitizeLabelSegment(fixture.requestedBy, "operator"),
    sanitizeFileName(fixture.sessionName),
  ].join("_");
  const archiveFileName = `${fileStem}.zip`;
  const telemetryFileName = `${fileStem}_telemetry.csv`;
  const sessionFolderId = `rec-folder-${fixture.id}`;

  filesStore.set(sessionFolderId, {
    id: sessionFolderId,
    parentId: fixture.targetFolderId,
    name: fixture.sessionName,
    type: "folder",
    date: fixture.createdAt,
    recordingId: fixture.id,
  });

  [
    {
      id: `rec-csv-${fixture.id}`,
      name: telemetryFileName,
      type: "csv" as const,
      size: "4.2 MB",
    },
    {
      id: `rec-front-${fixture.id}`,
      name: `${fileStem}_front_camera.mp4`,
      type: "mp4" as const,
      size: "125 MB",
    },
    {
      id: `rec-cockpit-${fixture.id}`,
      name: `${fileStem}_cockpit_camera.mp4`,
      type: "mp4" as const,
      size: "126 MB",
    },
    {
      id: `rec-rear-${fixture.id}`,
      name: `${fileStem}_rear_camera.mp4`,
      type: "mp4" as const,
      size: "124 MB",
    },
    {
      id: `rec-zip-${fixture.id}`,
      name: archiveFileName,
      type: "zip" as const,
      size: "412 MB",
    },
  ].forEach((file) => {
    filesStore.set(file.id, {
      id: file.id,
      parentId: sessionFolderId,
      name: file.name,
      type: file.type,
      size: file.size,
      date: fixture.createdAt,
      recordingId: fixture.id,
    });
  });

  recordingsStore.set(fixture.id, {
    id: fixture.id,
    vehicleId: fixture.vehicleId,
    sessionName: fixture.sessionName,
    startDate: fixture.startDate,
    endDate: fixture.endDate,
    status: fixture.status,
    fileCount: 5,
    createdAt: fixture.createdAt,
    targetFolderId: fixture.targetFolderId,
    archiveFileName,
    sourcePage: fixture.sourcePage,
    requestedBy: fixture.requestedBy,
    sessionFolderId,
  });
}

function seedRecordingFixtures(): void {
  if (recordingsStore.size > 0) {
    return;
  }

  filesStore.set("incident-review", {
    id: "incident-review",
    parentId: "root",
    name: "Incident Review",
    type: "folder",
    date: "2026-03-16T11:20:00Z",
  });

  seedRecordingFixture({
    id: "rec-seed-engineering-1",
    vehicleId: 12,
    sessionName: "Engineering_Buriram_RunPlan_A",
    startDate: "2026-03-16T10:00:00Z",
    endDate: "2026-03-16T10:22:00Z",
    createdAt: "2026-03-16T10:23:10Z",
    targetFolderId: "event-1",
    sourcePage: "ENGINEERING",
    requestedBy: "Trackside Engineer",
    status: "ready",
  });

  seedRecordingFixture({
    id: "rec-seed-director-1",
    vehicleId: 18,
    sessionName: "Director_Incident_Window_T3",
    startDate: "2026-03-16T11:31:00Z",
    endDate: "2026-03-16T11:36:00Z",
    createdAt: "2026-03-16T11:36:05Z",
    targetFolderId: "incident-review",
    sourcePage: "DIRECTOR",
    requestedBy: "Race Director",
    status: "processing",
  });
}

seedRecordingFixtures();

function resolveCameraView(cameraParam: string | null): CameraView {
  if (!cameraParam) return "FRONT";
  const normalized = cameraParam.toUpperCase();
  return normalized in CAMERA_STREAMS ? (normalized as CameraView) : "FRONT";
}

const http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const method = req.method ?? "";
  const url = req.url ?? "";
  const parsedUrl = new URL(url, "http://localhost");

  // CORS preflight
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });
    res.end();
    return;
  }

  // GET /fleet
  if (method === "GET" && url === "/fleet") {
    jsonResponse(res, 200, { cars: db.CARS });
    return;
  }

  // GET /drivers?carIds=12,18,4  (carIds param is optional)
  if (method === "GET" && url.startsWith("/drivers")) {
    const { searchParams } = parsedUrl;
    const carIdsParam = searchParams.get("carIds");
    const drivers = carIdsParam
      ? db.DRIVERS.filter((d) =>
          carIdsParam.split(",").map(Number).includes(d.carId),
        )
      : db.DRIVERS;
    jsonResponse(res, 200, { drivers });
    return;
  }

  if (method === "GET" && parsedUrl.pathname === "/tasks") {
    jsonResponse(res, 200, { tasks: Array.from(tasksStore.values()) });
    return;
  }

  if (method === "POST" && parsedUrl.pathname === "/tasks") {
    try {
      const raw = await readBody(req);
      const body = JSON.parse(raw) as Partial<Omit<Task, "id">>;
      if (!body.title?.trim()) {
        jsonResponse(res, 400, {
          error: { message: "Task title is required." },
        });
        return;
      }

      const defaultAssignee = getTaskAssignableUsers()[0]?.name ?? "Unassigned";
      const task: Task = {
        id: createId("task"),
        title: body.title.trim(),
        description: body.description?.trim() ?? "",
        status: body.status ?? "TODO",
        priority: body.priority ?? "LOW",
        assignee: resolveTaskAssignee(body.assignee, defaultAssignee),
        dueDate: body.dueDate,
        attachment: body.attachment,
      };
      tasksStore.set(task.id, task);
      jsonResponse(res, 201, task);
    } catch {
      jsonResponse(res, 400, { error: "invalid JSON body" });
    }
    return;
  }

  if (method === "GET" && parsedUrl.pathname === "/administration/events") {
    jsonResponse(res, 200, { events: Array.from(eventsStore.values()) });
    return;
  }

  if (method === "POST" && parsedUrl.pathname === "/administration/events") {
    try {
      const raw = await readBody(req);
      const body = JSON.parse(raw) as Omit<RaceEvent, "id">;
      const event: RaceEvent = {
        id: createId("event"),
        name: body.name ?? "New Event",
        track: body.track ?? "Buriram International Circuit",
        sessionType: body.sessionType ?? "PRACTICE",
        scheduledAt: body.scheduledAt ?? new Date().toISOString(),
        status: body.status ?? "upcoming",
      };
      eventsStore.set(event.id, event);
      jsonResponse(res, 201, event);
    } catch {
      jsonResponse(res, 400, { error: "invalid JSON body" });
    }
    return;
  }

  if (method === "GET" && parsedUrl.pathname === "/administration/users") {
    jsonResponse(res, 200, { users: Array.from(adminUsersStore.values()) });
    return;
  }

  if (method === "GET" && parsedUrl.pathname === "/auth/mock-credentials") {
    if (!demoCredentialListingEnabled) {
      jsonResponse(res, 404, { error: "not found" });
      return;
    }

    jsonResponse(res, 200, {
      credentials: mockCredentials.map(({ password, ...credential }) => ({
        ...credential,
        password,
      })),
    });
    return;
  }

  if (method === "POST" && parsedUrl.pathname === "/auth/login") {
    if (!mockAuthEnabled) {
      jsonResponse(res, 404, { error: "not found" });
      return;
    }

    try {
      const raw = await readBody(req);
      const body = JSON.parse(raw) as { email?: string; password?: string };
      const email = body.email?.trim().toLowerCase() ?? "";
      const password = body.password ?? "";
      const credential = mockCredentials.find(
        (entry) =>
          entry.email.toLowerCase() === email && entry.password === password,
      );

      if (!credential) {
        jsonResponse(res, 401, {
          authenticated: false,
          error: "invalid mock credentials",
        });
        return;
      }

      const claims = buildClaims(credential);
      const accessToken = signJwt(claims);

      jsonResponse(res, 200, {
        authenticated: true,
        accessToken,
        tokenType: "Bearer",
        expiresAt: new Date(claims.exp * 1000).toISOString(),
        user: {
          id: credential.id,
          name: credential.name,
          role: credential.role,
          email: credential.email,
          access: credential.access,
          permissions: claims.permissions,
        },
        landingPage: credential.landingPage,
      });
    } catch {
      jsonResponse(res, 400, { error: "invalid JSON body" });
    }
    return;
  }

  if (method === "GET" && parsedUrl.pathname === "/auth/me") {
    if (!mockAuthEnabled) {
      jsonResponse(res, 404, { error: "not found" });
      return;
    }

    const token = getBearerToken(req);
    const claims = token ? verifyJwt(token) : null;
    if (!claims) {
      jsonResponse(res, 401, {
        error: {
          code: "UNAUTHORIZED",
          message: "Authentication required.",
        },
      });
      return;
    }

    const credential = mockCredentials.find((entry) => entry.id === claims.sub);
    if (!credential) {
      jsonResponse(res, 401, {
        error: {
          code: "UNAUTHORIZED",
          message: "Authentication required.",
        },
      });
      return;
    }

    jsonResponse(res, 200, {
      authenticated: true,
      user: {
        id: credential.id,
        name: credential.name,
        role: credential.role,
        email: credential.email,
        access: credential.access,
        permissions: claims.permissions,
      },
      claims,
      landingPage: credential.landingPage,
    });
    return;
  }

  if (method === "POST" && parsedUrl.pathname === "/administration/users") {
    try {
      const raw = await readBody(req);
      const body = JSON.parse(raw) as Omit<AdminUser, "id">;
      const user: AdminUser = {
        id: createId("user"),
        name: body.name ?? "New User",
        role: body.role ?? "Engineer",
        email: body.email ?? "new.user@isuzu-racing.local",
        access: body.access ?? inferAccessFromRole(body.role ?? "Engineer"),
      };
      adminUsersStore.set(user.id, user);
      jsonResponse(res, 201, user);
    } catch {
      jsonResponse(res, 400, { error: "invalid JSON body" });
    }
    return;
  }

  if (method === "GET" && parsedUrl.pathname === "/administration/garages") {
    jsonResponse(res, 200, { garages: Array.from(garagesStore.values()) });
    return;
  }

  if (method === "GET" && parsedUrl.pathname === "/files/tree") {
    jsonResponse(res, 200, {
      files: Array.from(filesStore.values()).map(toPublicFileNode),
    });
    return;
  }

  if (method === "GET" && parsedUrl.pathname === "/recordings") {
    const vehicleIdParam = parsedUrl.searchParams.get("vehicleId");
    const vehicleId = vehicleIdParam ? Number(vehicleIdParam) : undefined;
    const recordings = Array.from(recordingsStore.values())
      .filter((recording) =>
        vehicleId !== undefined ? recording.vehicleId === vehicleId : true,
      )
      .map(toPublicRecordingSession)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

    jsonResponse(res, 200, { recordings });
    return;
  }

  if (method === "POST" && parsedUrl.pathname === "/recordings") {
    try {
      const raw = await readBody(req);
      const body = JSON.parse(raw) as CreateRecordingRequestBody;
      const vehicleId = Number(body.vehicleId);
      if (!Number.isFinite(vehicleId) || vehicleId <= 0) {
        jsonResponse(res, 400, {
          error: { message: "vehicleId must be a positive number." },
        });
        return;
      }

      const result = createRecordingSession(vehicleId, body);
      if ("error" in result) {
        jsonResponse(res, result.error.status, {
          error: { message: result.error.message },
        });
        return;
      }

      jsonResponse(res, 201, result);
    } catch {
      jsonResponse(res, 400, { error: "invalid JSON body" });
    }
    return;
  }

  if (method === "GET") {
    const recordingDownloadMatch = parsedUrl.pathname.match(
      /^\/recordings\/([^/]+)\/download$/,
    );
    if (recordingDownloadMatch) {
      const recordingId = decodeURIComponent(recordingDownloadMatch[1]);
      const recording = recordingsStore.get(recordingId);
      if (!recording) {
        jsonResponse(res, 404, {
          error: { code: "NOT_FOUND", message: "Recording not found." },
        });
        return;
      }

      const publicSession = toPublicRecordingSession(recording);
      if (publicSession.status !== "ready" || !publicSession.downloadUrl) {
        jsonResponse(res, 409, {
          error: {
            code: "RECORDING_NOT_READY",
            message: "Recording is not ready for download yet.",
          },
        });
        return;
      }

      jsonResponse(res, 200, {
        recordingId,
        status: publicSession.status,
        url: publicSession.downloadUrl,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        fileName: publicSession.archiveFileName,
      });
      return;
    }
  }

  if (method === "POST" && parsedUrl.pathname === "/administration/garages") {
    try {
      const raw = await readBody(req);
      const body = JSON.parse(raw) as Omit<Garage, "id">;
      const garage: Garage = {
        id: createId("garage"),
        name: body.name ?? "New Garage",
        location: body.location ?? "Unknown",
        teamId: body.teamId ?? "isuzu-racing",
        assignedCarIds: Array.isArray(body.assignedCarIds)
          ? body.assignedCarIds
          : [],
      };
      garagesStore.set(garage.id, garage);
      jsonResponse(res, 201, garage);
    } catch {
      jsonResponse(res, 400, { error: "invalid JSON body" });
    }
    return;
  }

  if (method === "POST") {
    const engineeringRecordingMatch = parsedUrl.pathname.match(
      /^\/engineering\/cars\/(\d+)\/recordings$/,
    );
    if (engineeringRecordingMatch) {
      try {
        const vehicleId = Number(engineeringRecordingMatch[1]);
        const raw = await readBody(req);
        const body = JSON.parse(raw) as CreateRecordingRequestBody;
        const result = createRecordingSession(vehicleId, body);

        if ("error" in result) {
          jsonResponse(res, result.error.status, {
            error: { message: result.error.message },
          });
          return;
        }

        jsonResponse(res, 201, result);
      } catch {
        jsonResponse(res, 400, { error: "invalid JSON body" });
      }
      return;
    }
  }

  // GET /users/:userId/preferences/engineering-layout
  if (method === "GET") {
    const engineeringLayoutMatch = parsedUrl.pathname.match(
      /^\/users\/([^/]+)\/preferences\/engineering-layout$/,
    );
    if (engineeringLayoutMatch) {
      const userId = decodeURIComponent(engineeringLayoutMatch[1]);
      jsonResponse(res, 200, engineeringLayoutStore.get(userId) ?? null);
      return;
    }

    const raceControlLayoutMatch = parsedUrl.pathname.match(
      /^\/users\/([^/]+)\/preferences\/race-control-layout$/,
    );
    if (raceControlLayoutMatch) {
      const userId = decodeURIComponent(raceControlLayoutMatch[1]);
      const stored = raceControlLayoutStore.get(userId);
      if (!stored) {
        jsonResponse(res, 200, null);
        return;
      }
      jsonResponse(res, 200, {
        mainLayout: stored.mainLayout,
        sensorLayouts: stored.sensorLayouts,
        theme: stored.theme,
      });
      return;
    }
  }

  // GET /vehicles/:vehicleId/stream?camera=FRONT|COCKPIT|REAR
  if (method === "GET") {
    const streamMatch = parsedUrl.pathname.match(/^\/vehicles\/(\d+)\/stream$/);
    if (streamMatch) {
      const vehicleId = Number(streamMatch[1]);
      const vehicle = db.CARS.find((car) => car.id === vehicleId);
      if (!vehicle) {
        jsonResponse(res, 404, { error: "vehicle not found" });
        return;
      }

      const camera = resolveCameraView(parsedUrl.searchParams.get("camera"));
      jsonResponse(res, 200, {
        vehicleId,
        camera,
        streamUrl: CAMERA_STREAMS[camera],
        streamMimeType: "video/mp4",
      });
      return;
    }
  }

  if (method === "PUT") {
    const eventMatch = parsedUrl.pathname.match(
      /^\/administration\/events\/([^/]+)$/,
    );
    if (eventMatch) {
      try {
        const id = decodeURIComponent(eventMatch[1]);
        const current = eventsStore.get(id);
        if (!current) {
          jsonResponse(res, 404, { error: "event not found" });
          return;
        }
        const raw = await readBody(req);
        const body = JSON.parse(raw) as Partial<Omit<RaceEvent, "id">>;
        const updated: RaceEvent = { ...current, ...body };
        eventsStore.set(id, updated);
        jsonResponse(res, 200, updated);
      } catch {
        jsonResponse(res, 400, { error: "invalid JSON body" });
      }
      return;
    }
  }

  // PUT /users/:userId/preferences/engineering-layout
  if (method === "PUT") {
    const engineeringLayoutMatch = parsedUrl.pathname.match(
      /^\/users\/([^/]+)\/preferences\/engineering-layout$/,
    );
    if (engineeringLayoutMatch) {
      try {
        const userId = decodeURIComponent(engineeringLayoutMatch[1]);
        const raw = await readBody(req);
        const body = JSON.parse(raw) as Partial<StoredEngineeringLayout>;
        engineeringLayoutStore.set(userId, {
          layout: Array.isArray(body.layout) ? body.layout : [],
          hiddenWidgets: Array.isArray(body.hiddenWidgets)
            ? body.hiddenWidgets
            : [],
          visualIdentityColor:
            typeof body.visualIdentityColor === "string"
              ? body.visualIdentityColor
              : undefined,
        });
        jsonResponse(res, 200, {
          saved: true,
          updatedAt: new Date().toISOString(),
        });
      } catch {
        jsonResponse(res, 400, { error: "invalid JSON body" });
      }
      return;
    }

    const raceControlLayoutMatch = parsedUrl.pathname.match(
      /^\/users\/([^/]+)\/preferences\/race-control-layout$/,
    );
    if (raceControlLayoutMatch) {
      try {
        const userId = decodeURIComponent(raceControlLayoutMatch[1]);
        const raw = await readBody(req);
        const body = JSON.parse(raw) as Partial<StoredRaceControlLayout>;
        // Validate theme object
        const theme =
          body.theme && typeof body.theme === "object"
            ? {
                primary:
                  typeof body.theme.primary === "string"
                    ? body.theme.primary
                    : "#ffffff",
                accent:
                  typeof body.theme.accent === "string"
                    ? body.theme.accent
                    : "#ff3333",
                accentGlow:
                  typeof body.theme.accentGlow === "string"
                    ? body.theme.accentGlow
                    : "rgba(255,51,51,0.4)",
                brandGradientEnd:
                  typeof body.theme.brandGradientEnd === "string"
                    ? body.theme.brandGradientEnd
                    : "#ffffff",
              }
            : {
                primary: "#ffffff",
                accent: "#ff3333",
                accentGlow: "rgba(255,51,51,0.4)",
                brandGradientEnd: "#ffffff",
              };
        raceControlLayoutStore.set(userId, {
          mainLayout: Array.isArray(body.mainLayout) ? body.mainLayout : [],
          sensorLayouts:
            body.sensorLayouts && typeof body.sensorLayouts === "object"
              ? body.sensorLayouts
              : {},
          theme,
        });
        jsonResponse(res, 200, {
          saved: true,
          updatedAt: new Date().toISOString(),
          theme,
        });
      } catch {
        jsonResponse(res, 400, { error: "invalid JSON body" });
      }
      return;
    }
  }

  if (method === "PATCH") {
    const taskMatch = parsedUrl.pathname.match(/^\/tasks\/([^/]+)$/);
    if (taskMatch) {
      try {
        const id = decodeURIComponent(taskMatch[1]);
        const current = tasksStore.get(id);
        if (!current) {
          jsonResponse(res, 404, { error: { message: "Task not found." } });
          return;
        }

        const raw = await readBody(req);
        const body = JSON.parse(raw) as Partial<Omit<Task, "id">>;
        const updated: Task = {
          ...current,
          ...body,
          title:
            body.title !== undefined
              ? body.title.trim() || current.title
              : current.title,
          description:
            body.description !== undefined
              ? body.description.trim()
              : current.description,
          assignee: resolveTaskAssignee(body.assignee, current.assignee),
        };
        tasksStore.set(id, updated);
        jsonResponse(res, 200, updated);
      } catch {
        jsonResponse(res, 400, { error: "invalid JSON body" });
      }
      return;
    }
  }

  if (method === "DELETE") {
    const fileMatch = parsedUrl.pathname.match(/^\/files\/([^/]+)$/);
    if (fileMatch) {
      const fileId = decodeURIComponent(fileMatch[1]);
      const target = filesStore.get(fileId);
      if (!target) {
        jsonResponse(res, 404, {
          error: { code: "NOT_FOUND", message: "File or folder not found." },
        });
        return;
      }

      try {
        const raw = await readBody(req);
        const body = JSON.parse(raw) as { password?: string };
        if ((body.password ?? "") !== deleteFilePassword) {
          jsonResponse(res, 403, {
            error: {
              code: "INVALID_DELETE_PASSWORD",
              message: "Invalid administrator password.",
            },
          });
          return;
        }

        const deletedIds = collectDescendantIds(fileId);
        const deletedRecordingIds = Array.from(
          new Set(
            deletedIds
              .map((id) => filesStore.get(id)?.recordingId)
              .filter((value): value is string => Boolean(value)),
          ),
        );

        deletedIds.forEach((id) => {
          filesStore.delete(id);
        });
        deletedRecordingIds.forEach((recordingId) => {
          recordingsStore.delete(recordingId);
        });

        jsonResponse(res, 200, { deletedIds, deletedRecordingIds });
      } catch {
        jsonResponse(res, 400, { error: "invalid JSON body" });
      }
      return;
    }

    const taskMatch = parsedUrl.pathname.match(/^\/tasks\/([^/]+)$/);
    if (taskMatch) {
      const id = decodeURIComponent(taskMatch[1]);
      if (!tasksStore.has(id)) {
        jsonResponse(res, 404, { error: { message: "Task not found." } });
        return;
      }
      tasksStore.delete(id);
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods":
          "GET, POST, PUT, PATCH, OPTIONS, DELETE",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      });
      res.end();
      return;
    }

    const eventMatch = parsedUrl.pathname.match(
      /^\/administration\/events\/([^/]+)$/,
    );
    if (eventMatch) {
      const id = decodeURIComponent(eventMatch[1]);
      eventsStore.delete(id);
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods":
          "GET, POST, PUT, PATCH, OPTIONS, DELETE",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      });
      res.end();
      return;
    }

    const userMatch = parsedUrl.pathname.match(
      /^\/administration\/users\/([^/]+)$/,
    );
    if (userMatch) {
      const id = decodeURIComponent(userMatch[1]);
      adminUsersStore.delete(id);
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods":
          "GET, POST, PUT, PATCH, OPTIONS, DELETE",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      });
      res.end();
      return;
    }

    const garageMatch = parsedUrl.pathname.match(
      /^\/administration\/garages\/([^/]+)$/,
    );
    if (garageMatch) {
      const id = decodeURIComponent(garageMatch[1]);
      garagesStore.delete(id);
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods":
          "GET, POST, PUT, PATCH, OPTIONS, DELETE",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      });
      res.end();
      return;
    }
  }

  // GET /alert-thresholds
  if (method === "GET" && parsedUrl.pathname === "/alert-thresholds") {
    jsonResponse(res, 200, { thresholds: alertThresholdsStore });
    return;
  }

  // PUT /alert-thresholds
  if (method === "PUT" && parsedUrl.pathname === "/alert-thresholds") {
    try {
      const raw = await readBody(req);
      const body = JSON.parse(raw) as { thresholds?: AlertThreshold[] };
      if (!Array.isArray(body.thresholds)) {
        jsonResponse(res, 400, { error: "thresholds array required" });
        return;
      }
      // Replace the store contents with the incoming thresholds
      alertThresholdsStore.length = 0;
      alertThresholdsStore.push(...body.thresholds);
      console.log(
        "[REST] PUT /alert-thresholds — updated",
        alertThresholdsStore.length,
        "entries",
      );
      jsonResponse(res, 200, {
        saved: true,
        thresholds: alertThresholdsStore,
        updatedAt: new Date().toISOString(),
      });
    } catch {
      jsonResponse(res, 400, { error: "invalid JSON body" });
    }
    return;
  }

  // GET /director/thresholds
  if (method === "GET" && url === "/director/thresholds") {
    const current = db.getAnomalyThresholds();
    // Serialize engine MetricKey names back to the API shape (inverse of METRIC_MAP).
    const apiThresholds: Record<
      string,
      { threshold: number; alertDelay: number; warningPenalty: number }
    > = {};
    for (const [apiKey, engineKey] of Object.entries(METRIC_MAP)) {
      const cfg = current[engineKey];
      if (cfg) {
        apiThresholds[apiKey] = {
          threshold: cfg.threshold,
          alertDelay: cfg.alertDelaySec,
          warningPenalty: cfg.violationsPerAnomaly,
        };
      }
    }
    jsonResponse(res, 200, {
      thresholds: apiThresholds,
      updatedAt: new Date().toISOString(),
    });
    return;
  }

  if (method === "GET" && url === "/director/refresh-rate") {
    jsonResponse(res, 200, {
      refreshRateHz: directorRefreshRateHz,
      updatedAt: new Date().toISOString(),
    });
    return;
  }

  // PUT /director/thresholds
  if (method === "PUT" && url === "/director/thresholds") {
    try {
      const raw = await readBody(req);
      const body = JSON.parse(raw) as {
        thresholds: Record<
          string,
          { threshold: number; alertDelay: number; warningPenalty: number }
        >;
      };
      if (!body.thresholds || typeof body.thresholds !== "object") {
        jsonResponse(res, 400, { error: "thresholds object required" });
        return;
      }
      const update: Partial<Record<db.MetricKey, db.MetricThresholdConfig>> =
        {};
      for (const [apiKey, cfg] of Object.entries(body.thresholds)) {
        const engineKey = METRIC_MAP[apiKey];
        if (!engineKey) continue; // unmapped metrics (ignitionTiming, airflow) skipped
        update[engineKey] = {
          threshold: Number(cfg.threshold),
          alertDelaySec: Number(cfg.alertDelay),
          violationsPerAnomaly: Math.max(
            1,
            Math.round(Number(cfg.warningPenalty)),
          ),
        };
      }
      db.setAnomalyThresholds(update);
      console.log(
        "[REST] PUT /director/thresholds — updated",
        Object.keys(update).join(", "),
      );
      jsonResponse(res, 200, {
        saved: true,
        updatedAt: new Date().toISOString(),
      });
    } catch {
      jsonResponse(res, 400, { error: "invalid JSON body" });
    }
    return;
  }

  if (method === "PUT" && url === "/director/refresh-rate") {
    try {
      const raw = await readBody(req);
      const body = JSON.parse(raw) as { refreshRateHz?: number };
      const nextRefreshRateHz = Number(body.refreshRateHz);
      if (!Number.isFinite(nextRefreshRateHz) || nextRefreshRateHz <= 0) {
        jsonResponse(res, 400, {
          error: "refreshRateHz must be a positive number",
        });
        return;
      }

      directorRefreshRateHz = nextRefreshRateHz;
      startTelemetryTimer();
      jsonResponse(res, 200, {
        saved: true,
        refreshRateHz: directorRefreshRateHz,
        updatedAt: new Date().toISOString(),
      });
    } catch {
      jsonResponse(res, 400, { error: "invalid JSON body" });
    }
    return;
  }

  // All other paths — proxy to Stoplight Prism on port 4000
  const PRISM_PORT = Number(process.env.PRISM_PORT ?? 4000);
  try {
    const prismUrl = `http://localhost:${PRISM_PORT}${url}`;
    const prismBody =
      method !== "GET" && method !== "DELETE" && method !== "HEAD"
        ? await readBody(req)
        : undefined;
    const prismRes = await fetch(prismUrl, {
      method,
      headers: {
        ...(prismBody ? { "Content-Type": "application/json" } : {}),
        ...(req.headers["authorization"]
          ? { Authorization: req.headers["authorization"] as string }
          : {}),
      },
      ...(prismBody ? { body: prismBody } : {}),
    });
    const responseBody = await prismRes.text();
    const ct =
      prismRes.headers.get("content-type") ?? "application/json; charset=utf-8";
    res.writeHead(prismRes.status, {
      "Content-Type": ct,
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });
    res.end(responseBody);
  } catch {
    jsonResponse(res, 502, {
      error: `Prism backend unavailable on port ${PRISM_PORT}`,
    });
  }
});
const io = new Server(http, { cors: { origin: "*" } });
const PORT = Number(process.env.PORT ?? process.env.WS_PORT ?? 4001);

// Per-socket subscriptions: socketId -> channel -> vehicleId (undefined = fleet/all)
type ChannelSubs = Map<string, number | undefined>;
const subsMap = new Map<string, ChannelSubs>();

io.on("connection", (socket: Socket) => {
  subsMap.set(socket.id, new Map());
  console.log(`[WS] connected    ${socket.id}`);

  socket.on("subscribe", (payload: { channel: string; vehicleId?: number }) => {
    subsMap.get(socket.id)?.set(payload.channel, payload.vehicleId);
    console.log(
      `[WS] subscribe    ${socket.id}  ${payload.channel}  vehicleId=${payload.vehicleId ?? "* (fleet)"}`,
    );
  });

  socket.on("unsubscribe", (payload: { channel: string }) => {
    subsMap.get(socket.id)?.delete(payload.channel);
    console.log(`[WS] unsubscribe  ${socket.id}  ${payload.channel}`);
  });

  socket.on("disconnect", () => {
    subsMap.delete(socket.id);
    console.log(`[WS] disconnected ${socket.id}`);
  });
});

function broadcast(
  channel: string,
  builder: (vehicleId: number) => unknown,
): void {
  for (const [socketId, subs] of subsMap) {
    if (!subs.has(channel)) continue;
    const vehicleId = subs.get(channel);
    const s = io.sockets.sockets.get(socketId);
    if (!s) continue;
    if (vehicleId === undefined) {
      // Fleet subscription — emit one frame per known vehicle
      for (const car of db.CARS) s.emit(channel, builder(car.id));
    } else {
      s.emit(channel, builder(vehicleId));
    }
  }
}

let tick = 0;

// Stores the latest telemetry frame per vehicleId so the anomaly broadcast
// can reference it without rebuilding the frame a second time.
const lastFrameMap = new Map<number, ReturnType<typeof db.buildTelemetryWs>>();

// telemetry + location — dynamic rate driven by directorRefreshRateHz.
// The timer is restarted whenever the admin changes the refresh rate via PUT.
let telemetryTimerId: ReturnType<typeof setInterval> | null = null;

function telemetryTick() {
  tick++;
  // Build frames and update anomaly state for ALL known cars unconditionally,
  // so anomaly counters advance even when no client subscribes to telemetry.
  for (const car of db.CARS) {
    const frame = db.buildTelemetryWs(car.id, tick);
    lastFrameMap.set(car.id, frame);
    db.updateAnomalyState(car.id, frame);
  }
  broadcast(
    "vehicle.telemetry",
    (id) => lastFrameMap.get(id) ?? db.buildTelemetryWs(id, tick),
  );
  broadcast("vehicle.sensors", (id) =>
    db.buildSensors(
      id,
      lastFrameMap.get(id) ?? db.buildTelemetryWs(id, tick),
      tick,
    ),
  );
  broadcast("vehicle.location", (id) => db.buildLocation(id, tick));
}

function startTelemetryTimer() {
  if (telemetryTimerId !== null) clearInterval(telemetryTimerId);
  const intervalMs = Math.max(20, Math.round(1000 / directorRefreshRateHz));
  telemetryTimerId = setInterval(telemetryTick, intervalMs);
  console.log(
    `[WS] Telemetry emit rate set to ${directorRefreshRateHz} Hz (${intervalMs}ms interval)`,
  );
}

startTelemetryTimer();

// anomaly summary - 1 Hz
// Emits per-vehicle violation/anomaly counts computed entirely on the backend.
// Thresholds (alertDelay, warningPenalty) default to Administration page defaults.
setInterval(() => {
  broadcast("vehicle.anomaly", (id) => {
    const last = lastFrameMap.get(id) ?? db.buildTelemetryWs(id, tick);
    return db.buildAnomalySummary(id, last);
  });
}, 1_000);

// biometric - 1 Hz
setInterval(() => {
  broadcast("vehicle.biometric", (id) => db.buildBiometric(id, tick));
}, 1_000);

// status - every 5 s
setInterval(() => {
  broadcast("vehicle.status", (id) => db.buildStatus(id, tick));
}, 5_000);

// alert push - every 20 s
setInterval(() => {
  broadcast("vehicle.alert", (id) => db.buildAlert(id));
}, 20_000);

http.listen(PORT, "0.0.0.0", () => {
  console.log(`[WS] Socket.IO listening on http://0.0.0.0:${PORT}`);
});
