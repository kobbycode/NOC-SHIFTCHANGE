import {
  ATTENDANCE_LOCATION_EVIDENCE_STATES,
  ATTENDANCE_LOCATION_NOT_CAPTURED_REASONS,
  ATTENDANCE_LOCATION_SOURCES,
  type AttendanceLocationEvidence,
  type AttendanceLocationEvidenceNotCaptured,
  type AttendanceLocationNotCapturedReason,
} from "@/types/attendance-location";

/**
 * Coarse office-presence evidence for a personal attendance act.
 *
 * The browser may report a geolocation fix when a technician joins a shift or
 * accepts a handover with their own password. It is evidence only: it never
 * blocks a join or acceptance. When the browser cannot produce a fix, the act
 * still records an explicit `not_captured` state with its reason.
 *
 * The record's `capturedAt` is the trusted server clock at the attendance act;
 * a browser-supplied timestamp is never trusted.
 */

const COORDINATE_SCALE = 100;
const ACCURACY_BUCKET_METERS = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString() === value
  );
}

function coarseCoordinate(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(value * COORDINATE_SCALE) / COORDINATE_SCALE;
}

function coarseAccuracy(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.max(
    ACCURACY_BUCKET_METERS,
    Math.round(value / ACCURACY_BUCKET_METERS) * ACCURACY_BUCKET_METERS,
  );
}

function notCaptured(
  capturedAt: string,
  reason: AttendanceLocationNotCapturedReason,
): AttendanceLocationEvidenceNotCaptured {
  return {
    state: ATTENDANCE_LOCATION_EVIDENCE_STATES.NOT_CAPTURED,
    source: ATTENDANCE_LOCATION_SOURCES.BROWSER_GEOLOCATION,
    capturedAt,
    reason,
  };
}

function readCapturedAt(nowIso: unknown): string {
  return isCanonicalTimestamp(nowIso)
    ? nowIso
    : new Date(0).toISOString();
}

/**
 * Normalizes untrusted browser evidence. A malformed payload is never an error:
 * it degrades to the explicit `not_captured` state so the personal attendance
 * act is never blocked by location. A missing payload is also `not_captured`
 * (`not_provided`), because every personal act records an explicit state.
 */
export function normalizeAttendanceLocationEvidence(
  value: unknown,
  nowIso: string,
): AttendanceLocationEvidence {
  const capturedAt = readCapturedAt(nowIso);

  if (value === null || value === undefined || !isRecord(value)) {
    return notCaptured(capturedAt, ATTENDANCE_LOCATION_NOT_CAPTURED_REASONS.NOT_PROVIDED);
  }

  if (value.state !== ATTENDANCE_LOCATION_EVIDENCE_STATES.CAPTURED) {
    const reason = Object.values(ATTENDANCE_LOCATION_NOT_CAPTURED_REASONS).includes(
      value.reason as AttendanceLocationNotCapturedReason,
    )
      ? (value.reason as AttendanceLocationNotCapturedReason)
      : ATTENDANCE_LOCATION_NOT_CAPTURED_REASONS.NOT_PROVIDED;
    return notCaptured(capturedAt, reason);
  }

  const latitude = coarseCoordinate(value.latitude);
  const longitude = coarseCoordinate(value.longitude);
  const accuracyMeters = coarseAccuracy(value.accuracyMeters);

  if (
    latitude === null ||
    longitude === null ||
    accuracyMeters === null ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    return notCaptured(capturedAt, ATTENDANCE_LOCATION_NOT_CAPTURED_REASONS.NOT_PROVIDED);
  }

  return {
    state: ATTENDANCE_LOCATION_EVIDENCE_STATES.CAPTURED,
    source: ATTENDANCE_LOCATION_SOURCES.BROWSER_GEOLOCATION,
    capturedAt,
    latitude,
    longitude,
    accuracyMeters,
  };
}