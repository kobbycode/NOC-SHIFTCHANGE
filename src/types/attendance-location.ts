/**
 * Coarse office-presence evidence recorded on a personal attendance act.
 *
 * Deliberately coarse: coordinates are rounded to two decimal places (~1 km)
 * and accuracy is bucketed to 100 m, so a technician's precise location is
 * never stored. It is evidence only and never blocks an attendance act.
 */

export const ATTENDANCE_LOCATION_EVIDENCE_STATES = {
  CAPTURED: "captured",
  NOT_CAPTURED: "not_captured",
} as const;

export type AttendanceLocationEvidenceState =
  (typeof ATTENDANCE_LOCATION_EVIDENCE_STATES)[keyof typeof ATTENDANCE_LOCATION_EVIDENCE_STATES];

export const ATTENDANCE_LOCATION_NOT_CAPTURED_REASONS = {
  PERMISSION_DENIED: "permission_denied",
  POSITION_UNAVAILABLE: "position_unavailable",
  TIMEOUT: "timeout",
  UNSUPPORTED: "unsupported",
  NOT_PROVIDED: "not_provided",
} as const;

export type AttendanceLocationNotCapturedReason =
  (typeof ATTENDANCE_LOCATION_NOT_CAPTURED_REASONS)[keyof typeof ATTENDANCE_LOCATION_NOT_CAPTURED_REASONS];

export const ATTENDANCE_LOCATION_SOURCES = {
  BROWSER_GEOLOCATION: "browser_geolocation",
} as const;

export type AttendanceLocationSource =
  (typeof ATTENDANCE_LOCATION_SOURCES)[keyof typeof ATTENDANCE_LOCATION_SOURCES];

export interface AttendanceLocationEvidenceCaptured {
  state: typeof ATTENDANCE_LOCATION_EVIDENCE_STATES.CAPTURED;
  source: AttendanceLocationSource;
  capturedAt: string;
  /** Rounded to two decimal places (~1.1 km at the equator). */
  latitude: number;
  longitude: number;
  /** Bucketed to the nearest 100 m, never finer. */
  accuracyMeters: number;
}

export interface AttendanceLocationEvidenceNotCaptured {
  state: typeof ATTENDANCE_LOCATION_EVIDENCE_STATES.NOT_CAPTURED;
  source: AttendanceLocationSource;
  capturedAt: string;
  reason: AttendanceLocationNotCapturedReason;
}

export type AttendanceLocationEvidence =
  | AttendanceLocationEvidenceCaptured
  | AttendanceLocationEvidenceNotCaptured;