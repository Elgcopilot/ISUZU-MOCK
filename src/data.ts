/**
 * src/data.ts
 * Realtime data generators for the Socket.IO WebSocket server.
 * REST mock data is served directly from openapi.yaml by Stoplight Prism —
 * nothing here duplicates what the spec already describes.
 */

// Minimal types used only by the WS generators ───────────────────────────────

export interface Car {
  id: number;
  number: string;
  model: string;
  status: string;
  color?: string;
}

export interface Driver {
  id: number;
  name: string;
  carId: number;
  license: string;
}

// ── Static reference data (lookup tables for WS generators) ─────────────────

// 30 racing-team colors – visually distinct on a dark telemetry dashboard.
const TEAM_COLORS = [
  "#ff1744",
  "#00e5ff",
  "#76ff03",
  "#ffea00",
  "#d500f9",
  "#ff9100",
  "#1de9b6",
  "#651fff",
  "#f50057",
  "#00b0ff",
  "#aeea00",
  "#ff6d00",
  "#00bfa5",
  "#304ffe",
  "#c51162",
  "#64dd17",
  "#0091ea",
  "#aa00ff",
  "#dd2c00",
  "#00c853",
  "#2979ff",
  "#ff3d00",
  "#00e676",
  "#6200ea",
  "#ffd600",
  "#ff6e40",
  "#18ffff",
  "#b388ff",
  "#69f0ae",
  "#ea80fc",
];

function generateCars(count: number): Car[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    number: String(i + 1).padStart(2, "0"),
    model:
      `Isuzu D-Max Proto ${i % 3 === 0 ? "" : i % 3 === 1 ? "2" : "3"}`.trim(),
    status: "Active",
    color: TEAM_COLORS[i % TEAM_COLORS.length],
  }));
}

const THAI_FIRST = [
  "Somchai",
  "Prasert",
  "Wanchai",
  "Kittisak",
  "Nattapong",
  "Suthep",
  "Chaiwat",
  "Apichat",
  "Surasak",
  "Tanawat",
  "Pongsakorn",
  "Anek",
  "Kritsada",
  "Worachat",
  "Supachai",
  "Jaturon",
  "Montri",
  "Paiboon",
  "Sakchai",
  "Thanakorn",
  "Pattana",
  "Narong",
  "Arthit",
  "Somsak",
  "Komkrit",
  "Noppadon",
  "Vorapot",
  "Rattana",
  "Prawit",
  "Chatchai",
];

const THAI_LAST = [
  "Rakdee",
  "Moonkhan",
  "Sombat",
  "Jaidee",
  "Thongkham",
  "Srisai",
  "Bunnak",
  "Suwannarat",
  "Kaewmanee",
  "Pibul",
];

function generateDrivers(cars: Car[]): Driver[] {
  return cars.map((car, i) => ({
    id: 100 + i,
    name: `${THAI_FIRST[i % THAI_FIRST.length]} ${THAI_LAST[i % THAI_LAST.length]}`,
    carId: car.id,
    license: i % 3 === 0 ? "FIA-A" : i % 3 === 1 ? "FIA-B" : "FIA-A",
  }));
}

export const CARS: Car[] = generateCars(30);
export const DRIVERS: Driver[] = generateDrivers(CARS);

// ── Realtime data generators ──────────────────────────────────────────────────

// Time-based reference so generators produce smooth, Hz-independent motion.
// Using elapsed real-time seconds instead of tick count means switching from
// 1 Hz to 25 Hz no longer makes cars orbit the track 25× faster.
const serverStartMs = Date.now();
function elapsed(): number {
  return (Date.now() - serverStartMs) / 1000;
}

function jitter(base: number, range: number): number {
  return base + (Math.random() - 0.5) * range * 2;
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function buildTire(idx: number) {
  const t = elapsed();
  const w = Math.sin(t * 0.6 + idx);
  return {
    speed: Math.round(jitter(215, 5) * 10) / 10,
    temp: Math.round(jitter(104 + idx * 2 + w * 5, 3)),
    press: Math.round((1.2 + w * 0.05) * 100) / 100,
    brake: Math.round(jitter(650 + idx * 20, 50)),
  };
}

/** WS telemetry frame — vehicle.telemetry channel (variable Hz). */
export function buildTelemetryWs(vehicleId: number, _tick: number) {
  const t = elapsed();
  const driver = DRIVERS.find((d) => d.carId === vehicleId);
  // ~0.16 Hz oscillation — one full wave every ~6 seconds
  const w = Math.sin(t * 0.5 + vehicleId * 0.5);
  const braking = w < -0.5;
  return {
    vehicleId,
    driverId: driver?.id ?? 1,
    timestamp: new Date().toISOString(),
    speed: Math.round((180 + w * 40 + jitter(0, 3)) * 10) / 10,
    rpm: Math.round(6000 + w * 2000 + jitter(0, 100)),
    fuel:
      Math.round(Math.max(0, 65 - t * 0.02 + (vehicleId % 3) * 5) * 10) / 10,
    fuelPressure: Math.round((4.2 + w * 0.3) * 100) / 100,
    oilTemp: Math.round((108 + w * 5 + jitter(0, 1)) * 10) / 10,
    throttle: Math.round(clamp(70 + w * 30 + jitter(0, 5), 0, 100)),
    brake: Math.round(braking ? jitter(70, 20) : jitter(2, 2)),
    gear: clamp(Math.round(4 + w * 2), 1, 6),
    lambda: Math.round((1.01 + w * 0.05) * 1000) / 1000,
    boost: Math.round((1.8 + w * 0.3) * 100) / 100,
    drs: w > 0.7,
    gLat: Math.round((w * 1.5 + jitter(0, 0.1)) * 100) / 100,
    gLong: Math.round(((braking ? 0.4 : -0.2) + jitter(0, 0.05)) * 100) / 100,
    heading: (t * 4 + vehicleId * 30) % 360,
    // Steering angle: sinusoidal with corner-entry spikes, ±120° range
    steering:
      Math.round(
        clamp(
          Math.sin(t * 0.8 + vehicleId * 0.7) * 90 + jitter(0, 5),
          -120,
          120,
        ) * 10,
      ) / 10,
    // Airflow (Mass Air Flow, g/s) and ignition timing (degrees advance BTDC)
    airflow: Math.round((260 + w * 80 + jitter(0, 10)) * 10) / 10,
    ignitionTiming: Math.round((28 + w * 8 + jitter(0, 1)) * 10) / 10,
    tires: {
      fl: buildTire(0),
      fr: buildTire(1),
      rl: buildTire(2),
      rr: buildTire(3),
    },
  };
}

/** WS location frame — vehicle.location channel (variable Hz). */
export function buildLocation(vehicleId: number, _tick: number) {
  const t = elapsed();
  const LAP_SECONDS = 90; // ~1:30 per lap — realistic circuit pace
  const carPhase = vehicleId * 0.33; // spread cars around the track
  return {
    vehicleId,
    timestamp: new Date().toISOString(),
    lat: 13.5 + Math.sin(t * 0.07 + vehicleId) * 0.002,
    lng: 102.0 + Math.cos(t * 0.07 + vehicleId) * 0.003,
    speed: Math.round(180 + Math.sin(t * 0.5 + vehicleId) * 40),
    heading: (t * 4 + vehicleId * 30) % 360,
    lap: Math.floor((t + carPhase) / LAP_SECONDS) + 1,
    lapProgress: ((t + carPhase) / LAP_SECONDS) % 1,
  };
}

/** WS biometric frame — vehicle.biometric channel (1 Hz). */
export function buildBiometric(vehicleId: number, _tick: number) {
  const t = elapsed();
  const driver = DRIVERS.find((d) => d.carId === vehicleId);
  const w = Math.sin(t * 0.4 + vehicleId);
  return {
    driverId: driver?.id ?? 1,
    vehicleId,
    timestamp: new Date().toISOString(),
    heartRate: Math.round(136 + w * 12 + jitter(0, 2)),
    respiration: Math.round(17 + w * 3 + jitter(0, 0.5)),
    stressLevel: Math.round(clamp(52 + w * 20 + jitter(0, 5), 0, 100)),
  };
}

/** WS status frame — vehicle.status channel (every 5 s). */
export function buildStatus(vehicleId: number, _tick: number) {
  const t = elapsed();
  const LAP_SECONDS = 90;
  const carPhase = vehicleId * 0.33;
  const driver = DRIVERS.find((d) => d.carId === vehicleId);
  return {
    vehicleId,
    driverId: driver?.id ?? 1,
    connectionState: "synchronized" as const,
    latencyMs: Math.round(20 + jitter(0, 8)),
    position: vehicleId <= 10 ? `P${vehicleId}` : `P${Math.min(vehicleId, 30)}`,
    lap: Math.floor((t + carPhase) / LAP_SECONDS) + 1,
    totalLaps: 67,
    currentTime: "1:22.405",
    bestTime: "1:21.503",
    timestamp: new Date().toISOString(),
  };
}

const ALERT_POOL = [
  { message: "Brake temp approaching limit", severity: "warning" as const },
  {
    message: "Fuel pressure fluctuation detected",
    severity: "warning" as const,
  },
  { message: "EGT spike on cylinder 3", severity: "critical" as const },
  { message: "DRS fault – auto retracted", severity: "critical" as const },
  { message: "Tire pressure delta >0.1 bar", severity: "info" as const },
];
let alertCounter = 100;

/** WS alert push — vehicle.alert channel (every 20 s). */
export function buildAlert(vehicleId: number) {
  const pool = ALERT_POOL[alertCounter % ALERT_POOL.length];
  alertCounter++;
  const alertId = `alert-ws-${alertCounter}`;
  const timestamp = new Date().toISOString();
  return {
    alertId,
    vehicleId,
    type: "THRESHOLD_BREACH",
    severity: pool.severity,
    message: pool.message,
    timestamp,
    acknowledged: false,
  };
}

// ── Sensor display categories ─────────────────────────────────────────────────
// Produces display-ready strings for all 20 sensor cards across 4 categories.
// Emitted on vehicle.sensors at 2 Hz alongside vehicle.telemetry so the frontend
// can render sensor panels without any client-side field mapping.

type SensorStatus = "ok" | "warn" | "error" | "calib";

interface SensorReading {
  name: string;
  value: string;
  status: SensorStatus;
  channel: string;
}

export interface VehicleSensors {
  vehicleId: number;
  timestamp: string;
  sensorCategories: {
    POWERTRAIN: SensorReading[];
    CHASSIS: SensorReading[];
    AERO: SensorReading[];
    ELECTRONICS: SensorReading[];
  };
}

export function buildSensors(
  vehicleId: number,
  frame: ReturnType<typeof buildTelemetryWs>,
  _tick: number,
): VehicleSensors {
  const {
    speed,
    oilTemp,
    fuelPressure,
    boost,
    airflow,
    gear,
    brake,
    steering,
    drs,
    gLat,
    tires,
  } = frame;
  const t = elapsed();
  const w = Math.sin(t * 0.5 + vehicleId * 0.5);

  // POWERTRAIN
  const oilPressure =
    Math.round((3.8 + oilTemp * 0.004 + w * 0.15) * 100) / 100;
  const fuelFlow = Math.round(airflow * 0.28 * 10) / 10;
  const gearboxTemp = Math.round(82 + gear * 7 + w * 4 + jitter(0, 1));
  const egt = Math.round(760 + boost * 25 + oilTemp * 0.4 + w * 15);

  // CHASSIS
  const flTravel = Math.round(
    clamp(100 + gLat * 25 + speed * 0.05 + jitter(0, 3), 60, 160),
  );
  const frTravel = Math.round(
    clamp(100 - gLat * 25 + speed * 0.05 + jitter(0, 3), 60, 160),
  );
  const brakePressure =
    Math.round(
      (brake > 5 ? brake * 0.55 + jitter(0, 2) : jitter(1.5, 0.5)) * 100,
    ) / 100;
  const tireAvgPress =
    Math.round(
      ((tires.fl.press + tires.fr.press + tires.rl.press + tires.rr.press) /
        4) *
        100,
    ) / 100;

  // AERO — downforce ∝ v²
  const frontDownforce = Math.round(speed * speed * 0.148 + w * 80);
  const rearDownforce = Math.round(speed * speed * 0.213 + w * 120);

  // ELECTRONICS
  const latency = Math.round(clamp(20 + jitter(0, 8), 12, 60));
  const sats = Math.round(clamp(11 + w * 2 + jitter(0, 0.5), 8, 14));
  const battV = Math.round((12.6 + w * 0.15 + jitter(0, 0.05)) * 100) / 100;

  return {
    vehicleId,
    timestamp: new Date().toISOString(),
    sensorCategories: {
      POWERTRAIN: [
        {
          name: "Engine Oil Pressure",
          value: `${oilPressure} bar`,
          status:
            oilPressure < 2.5 ? "error" : oilPressure < 3.5 ? "warn" : "ok",
          channel: "CH-1",
        },
        {
          name: "Fuel Flow Rate",
          value: `${fuelFlow} kg/h`,
          status: fuelPressure < 3.5 ? "warn" : "ok",
          channel: "CH-2",
        },
        {
          name: "Turbo Boost",
          value: `${boost.toFixed(2)} bar`,
          status: boost > 2.5 ? "warn" : "ok",
          channel: "CH-3",
        },
        {
          name: "Gearbox Temp",
          value: `${gearboxTemp} \u00b0C`,
          status:
            gearboxTemp > 130 ? "error" : gearboxTemp > 115 ? "warn" : "ok",
          channel: "CH-4",
        },
        {
          name: "Exhaust Gas Temp",
          value: `${egt} \u00b0C`,
          status: egt > 950 ? "error" : egt > 880 ? "warn" : "ok",
          channel: "CH-5",
        },
        {
          name: "Coolant Temp",
          value: `${oilTemp.toFixed(1)} \u00b0C`,
          status: oilTemp > 115 ? "error" : oilTemp > 105 ? "warn" : "ok",
          channel: "CH-6",
        },
      ],
      CHASSIS: [
        {
          name: "FL Suspension Travel",
          value: `${flTravel} mm`,
          status: flTravel > 148 ? "warn" : "ok",
          channel: "CH-7",
        },
        {
          name: "FR Suspension Travel",
          value: `${frTravel} mm`,
          status: frTravel > 148 ? "warn" : "ok",
          channel: "CH-8",
        },
        {
          name: "Brake Line Pressure",
          value: `${brakePressure} bar`,
          status: brakePressure > 50 ? "warn" : "ok",
          channel: "CH-9",
        },
        {
          name: "Steering Angle",
          value: `${steering.toFixed(1)}\u00b0`,
          status: "ok",
          channel: "CH-10",
        },
        {
          name: "Tire Pressure Monitor",
          value: `${tireAvgPress} bar`,
          status: tireAvgPress < 1.0 ? "warn" : "ok",
          channel: "CH-11",
        },
      ],
      AERO: [
        {
          name: "Front Wing Load",
          value: `${frontDownforce} N`,
          status: "ok",
          channel: "CH-12",
        },
        {
          name: "Rear Wing Load",
          value: `${rearDownforce} N`,
          status: "ok",
          channel: "CH-13",
        },
        {
          name: "Underbody Airflow",
          value: `${airflow.toFixed(1)} g/s`,
          status: "ok",
          channel: "CH-14",
        },
        {
          name: "DRS Status",
          value: drs ? "Open" : "Closed",
          status: drs ? "warn" : "ok",
          channel: "CH-15",
        },
      ],
      ELECTRONICS: [
        {
          name: "ECU Status",
          value: `Map ${gear}`,
          status: "ok",
          channel: "CH-16",
        },
        {
          name: "Telemetry Link",
          value: `5G - ${latency} ms`,
          status: latency > 45 ? "warn" : "ok",
          channel: "CH-17",
        },
        {
          name: "GPS Signal",
          value: `${sats} Sats`,
          status: sats < 9 ? "warn" : "ok",
          channel: "CH-18",
        },
        {
          name: "Battery Voltage",
          value: `${battV} V`,
          status: battV < 12.1 ? "warn" : "ok",
          channel: "CH-19",
        },
        {
          name: "Hybrid System",
          value: boost > 2.2 ? "Active" : "Ready",
          status: "ok",
          channel: "CH-20",
        },
      ],
    },
  };
}

// ── Anomaly detection engine ─────────────────────────────────────────────────
// Counts violations and anomalies (punishments) per vehicle per metric.
// Logic:
//   - A "violation" is counted when a metric stays above threshold continuously
//     for >= alertDelaySec seconds.
//   - An "anomaly" (punishment) is counted every violationsPerAnomaly violations.
// Thresholds default to the Administration page defaults; in production they
// would be pushed by the frontend via a REST endpoint.

export type MetricKey =
  | "rpm"
  | "speed"
  | "throttle"
  | "lambda"
  | "fuelPressure"
  | "airflow"
  | "ignitionTiming";

export interface MetricThresholdConfig {
  /** Value above which a breach is detected. */
  threshold: number;
  /** Seconds of continuous breach required to count 1 violation (alertDelay). */
  alertDelaySec: number;
  /** Number of violations required to count 1 anomaly/punishment (warningPenalty). */
  violationsPerAnomaly: number;
}

/**
 * Runtime-mutable threshold configuration.
 * Default values match the Administration page defaults.
 * Updated by setAnomalyThresholds() when PUT /director/thresholds is called.
 */
let runtimeThresholds: Record<MetricKey, MetricThresholdConfig> = {
  rpm: { threshold: 9000, alertDelaySec: 1.0, violationsPerAnomaly: 3 },
  speed: { threshold: 300, alertDelaySec: 2.0, violationsPerAnomaly: 5 },
  throttle: { threshold: 95, alertDelaySec: 1.0, violationsPerAnomaly: 3 },
  lambda: { threshold: 1.05, alertDelaySec: 1.0, violationsPerAnomaly: 3 },
  fuelPressure: { threshold: 5.0, alertDelaySec: 1.0, violationsPerAnomaly: 3 },
  airflow: { threshold: 380, alertDelaySec: 1.0, violationsPerAnomaly: 3 },
  ignitionTiming: {
    threshold: 38,
    alertDelaySec: 1.0,
    violationsPerAnomaly: 3,
  },
};

/** Backward-compat exported const — reads the mutable runtime state. */
export const ANOMALY_THRESHOLDS = runtimeThresholds as Readonly<
  Record<MetricKey, MetricThresholdConfig>
>;

/** Replace subset of runtime threshold config. Called from the REST PUT handler. */
export function setAnomalyThresholds(
  incoming: Partial<Record<MetricKey, MetricThresholdConfig>>,
): void {
  for (const key of Object.keys(incoming) as MetricKey[]) {
    if (runtimeThresholds[key] !== undefined) {
      runtimeThresholds[key] = { ...runtimeThresholds[key], ...incoming[key] };
    }
  }
}

/** Return a snapshot of the current runtime threshold config. */
export function getAnomalyThresholds(): Record<
  MetricKey,
  MetricThresholdConfig
> {
  return { ...runtimeThresholds };
}

interface MetricState {
  violations: number;
  anomalies: number;
  /** Epoch ms when the current continuous breach started; null if not currently breaching. */
  breachStartMs: number | null;
  stats: { min: number; max: number };
}

export interface MetricAnomalySummary {
  value: number;
  threshold: number;
  violations: number;
  anomalies: number;
  isBreaching: boolean;
  stats: { min: number; max: number };
}

export interface VehicleAnomalySummary {
  vehicleId: number;
  timestamp: string;
  totalViolations: number;
  totalAnomalies: number;
  metrics: Partial<Record<MetricKey, MetricAnomalySummary>>;
}

// vehicleId → (metricKey → MetricState)
const anomalyStateMap = new Map<number, Record<MetricKey, MetricState>>();

function initAnomalyState(): Record<MetricKey, MetricState> {
  const state = {} as Record<MetricKey, MetricState>;
  for (const key of Object.keys(runtimeThresholds) as MetricKey[]) {
    state[key] = {
      violations: 0,
      anomalies: 0,
      breachStartMs: null,
      stats: { min: Infinity, max: -Infinity },
    };
  }
  return state;
}

/**
 * Update per-vehicle anomaly state from a freshly-built telemetry frame.
 * Call once per telemetry tick for every known vehicle.
 */
export function updateAnomalyState(
  vehicleId: number,
  frame: ReturnType<typeof buildTelemetryWs>,
): void {
  if (!anomalyStateMap.has(vehicleId)) {
    anomalyStateMap.set(vehicleId, initAnomalyState());
  }
  const state = anomalyStateMap.get(vehicleId)!;
  const now = Date.now();

  const readings: Partial<Record<MetricKey, number>> = {
    rpm: frame.rpm,
    speed: frame.speed,
    throttle: frame.throttle,
    lambda: frame.lambda,
    fuelPressure: frame.fuelPressure,
    airflow: frame.airflow,
    ignitionTiming: frame.ignitionTiming,
  };

  for (const key of Object.keys(runtimeThresholds) as MetricKey[]) {
    const config = runtimeThresholds[key];
    const value = readings[key];
    if (value === undefined) continue;

    const ms = state[key];

    // Rolling min/max
    if (value < ms.stats.min) ms.stats.min = value;
    if (value > ms.stats.max) ms.stats.max = value;

    if (value > config.threshold) {
      if (ms.breachStartMs === null) {
        ms.breachStartMs = now; // start timing the breach
      } else {
        const durationSec = (now - ms.breachStartMs) / 1000;
        if (durationSec >= config.alertDelaySec) {
          ms.violations += 1;
          ms.breachStartMs = now; // reset timer — next violation needs another alertDelay
          if (ms.violations % config.violationsPerAnomaly === 0) {
            ms.anomalies += 1;
          }
        }
      }
    } else {
      ms.breachStartMs = null; // breach ended — reset timer
    }
  }
}

/** Build the current anomaly summary payload ready for broadcasting. */
export function buildAnomalySummary(
  vehicleId: number,
  lastFrame: ReturnType<typeof buildTelemetryWs>,
): VehicleAnomalySummary {
  if (!anomalyStateMap.has(vehicleId)) {
    anomalyStateMap.set(vehicleId, initAnomalyState());
  }
  const state = anomalyStateMap.get(vehicleId)!;

  const readings: Partial<Record<MetricKey, number>> = {
    rpm: lastFrame.rpm,
    speed: lastFrame.speed,
    throttle: lastFrame.throttle,
    lambda: lastFrame.lambda,
    fuelPressure: lastFrame.fuelPressure,
    airflow: lastFrame.airflow,
    ignitionTiming: lastFrame.ignitionTiming,
  };

  let totalViolations = 0;
  let totalAnomalies = 0;
  const metrics: Partial<Record<MetricKey, MetricAnomalySummary>> = {};

  for (const key of Object.keys(runtimeThresholds) as MetricKey[]) {
    const config = runtimeThresholds[key];
    const ms = state[key];
    totalViolations += ms.violations;
    totalAnomalies += ms.anomalies;
    metrics[key] = {
      value: readings[key] ?? 0,
      threshold: config.threshold,
      violations: ms.violations,
      anomalies: ms.anomalies,
      isBreaching: ms.breachStartMs !== null,
      stats: {
        min: ms.stats.min === Infinity ? 0 : ms.stats.min,
        max: ms.stats.max === -Infinity ? 0 : ms.stats.max,
      },
    };
  }

  return {
    vehicleId,
    timestamp: new Date().toISOString(),
    totalViolations,
    totalAnomalies,
    metrics,
  };
}
