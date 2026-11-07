import {
  ATTENDANCE_LOCATION_EVIDENCE_STATES,
  ATTENDANCE_LOCATION_NOT_CAPTURED_REASONS,
  ATTENDANCE_LOCATION_SOURCES,
  type AttendanceLocationEvidence,
  type AttendanceLocationNotCapturedReason,
} from "@/types/attendance-location";

/**
 * Browser-side coarse presence capture for a personal attendance act.
 *
 * Never rejects and never throws: any failure resolves to the explicit
 * not-captured state so a join or acceptance is never blocked. Coordinates are
 * rounded here as well as on the server so the network payload is already
 * coarse.
 */

export const COARSE_LOCATION_TIMEOUT_MS = 3_000;
export const COARSE_LOCATION_MAXIMUM_AGE_MS = 300_000;

const COORDINATE_SCALE = 100;
const ACCURACY_BUCKET_METERS = 100;

function roundCoordinate(value: number): number {
  return Math.round(value * COORDINATE_SCALE) / COORDINATE_SCALE;
}

function bucketAccuracy(value: number): number {
  return Math.max(
    ACCURACY_BUCKET_METERS,
    Math.round(value / ACCURACY_BUCKET_METERS) * ACCURACY_BUCKET_METERS,
  );
}

function notCaptured(
  reason: AttendanceLocationNotCapturedReason,
): AttendanceLocationEvidence {
  return {
    state: ATTENDANCE_LOCATION_EVIDENCE_STATES.NOT_CAPTURED,
    source: ATTENDANCE_LOCATION_SOURCES.BROWSER_GEOLOCATION,
    capturedAt: new Date().toISOString(),
    reason,
  };
}

function reasonFor(error: GeolocationPositionError): AttendanceLocationNotCapturedReason {
  switch (error.code) {
    case error.PERMISSION_DENIED:
      return ATTENDANCE_LOCATION_NOT_CAPTURED_REASONS.PERMISSION_DENIED;
    case error.POSITION_UNAVAILABLE:
      return ATTENDANCE_LOCATION_NOT_CAPTURED_REASONS.POSITION_UNAVAILABLE;
    case error.TIMEOUT:
      return ATTENDANCE_LOCATION_NOT_CAPTURED_REASONS.TIMEOUT;
    default:
      return ATTENDANCE_LOCATION_NOT_CAPTURED_REASONS.POSITION_UNAVAILABLE;
  }
}

export async function captureCoarseLocationEvidence(): Promise<AttendanceLocationEvidence> {
  if (
    typeof navigator === "undefined" ||
    !navigator.geolocation ||
    typeof navigator.geolocation.getCurrentPosition !== "function"
  ) {
    return notCaptured(ATTENDANCE_LOCATION_NOT_CAPTURED_REASONS.UNSUPPORTED);
  }

  return new Promise<AttendanceLocationEvidence>((resolve) => {
    let settled = false;
    const settle = (evidence: AttendanceLocationEvidence) => {
      if (settled) return;
      settled = true;
      resolve(evidence);
    };

    try {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const { latitude, longitude, accuracy } = position.coords;
          if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(accuracy)) {
            settle(notCaptured(ATTENDANCE_LOCATION_NOT_CAPTURED_REASONS.POSITION_UNAVAILABLE));
            return;
          }
          settle({
            state: ATTENDANCE_LOCATION_EVIDENCE_STATES.CAPTURED,
            source: ATTENDANCE_LOCATION_SOURCES.BROWSER_GEOLOCATION,
            capturedAt: new Date().toISOString(),
            latitude: roundCoordinate(latitude),
            longitude: roundCoordinate(longitude),
            accuracyMeters: bucketAccuracy(accuracy),
          });
        },
        (error) => settle(notCaptured(reasonFor(error))),
        {
          enableHighAccuracy: false,
          timeout: COARSE_LOCATION_TIMEOUT_MS,
          maximumAge: COARSE_LOCATION_MAXIMUM_AGE_MS,
        },
      );
    } catch {
      settle(notCaptured(ATTENDANCE_LOCATION_NOT_CAPTURED_REASONS.POSITION_UNAVAILABLE));
    }
  });
}