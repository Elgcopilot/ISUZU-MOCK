# ISUZU Mock Server — Agent Instructions

Combined REST + WebSocket mock server for the ISUZU Racing Platform. Runs on **port 4001** and provides both direct REST endpoints and Socket.IO realtime telemetry for 30 simulated race cars.

## Quick Start

```bash
# Development (REST Prism on 4000 + WebSocket server on 4001, with hot reload)
npm run dev

# Production
npm run start:prod
```

## Architecture

- **Port 4001** — `src/index.ts`: Express HTTP + Socket.IO server
  - Handles auth, fleet, drivers, tasks, recordings, layouts, thresholds directly
  - **Proxies all other routes to Prism on port 4000**
- **Port 4000** — Stoplight Prism: serves remaining OpenAPI routes from `openapi.yaml`

## Key Files

| File                             | Purpose                                           |
| -------------------------------- | ------------------------------------------------- |
| [`src/index.ts`](src/index.ts)   | Main server: all REST endpoints + Socket.IO setup |
| [`src/data.ts`](src/data.ts)     | 30 cars, 30 drivers, realtime data generators     |
| [`openapi.yaml`](openapi.yaml)   | REST API contract                                 |
| [`asyncapi.yaml`](asyncapi.yaml) | WebSocket event contract                          |

## Realtime Channels (Socket.IO)

Seven channels broadcast data continuously. Default telemetry rate: **5 Hz** (adjustable via `PUT /director/refresh-rate`).

| Channel             | Rate           | Data                             |
| ------------------- | -------------- | -------------------------------- |
| `vehicle.telemetry` | 5 Hz (default) | 25+ sensor fields, tire data     |
| `vehicle.sensors`   | 2 Hz           | Display-ready sensor categories  |
| `vehicle.location`  | ~1 Hz          | GPS + lap progress (30s lap sim) |
| `vehicle.status`    | every 5s       | Connection state, race position  |
| `vehicle.biometric` | 1 Hz           | Heart rate, respiration, stress  |
| `vehicle.anomaly`   | 1 Hz           | Threshold violation counters     |
| `vehicle.alert`     | every 20s      | Random alert events              |

Subscription protocol: client emits `subscribe { channel, vehicleId }`, server streams; client emits `unsubscribe` to stop.

## Mock Auth

JWT-based. Three roles with fixed credentials:

| Role     | Email              | Password     |
| -------- | ------------------ | ------------ |
| Admin    | admin@isuzu.com    | Admin@123    |
| Director | director@isuzu.com | Director@123 |
| Engineer | engineer@isuzu.com | Engineer@123 |

## Adding or Modifying Endpoints

1. Direct handlers: add in `src/index.ts` before the Prism proxy catch-all.
2. OpenAPI-only endpoints: update `openapi.yaml` — Prism serves them automatically.
3. New realtime channels: add generator in `src/data.ts`, broadcast in the Socket.IO loop in `src/index.ts`, document in `asyncapi.yaml`.

## Fleet Data

- **30 cars** (IDs 1–30): Isuzu D-Max Proto variants with team colors
- **30 drivers** (IDs 100–129): assigned 1:1 to cars
- All generators are deterministic and time-based (no randomness drift between restarts)
