import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { AssignmentOperationError } from "./assignment-transaction";
import { AttendanceEvidenceDomainError } from "./attendance-evidence-domain";
import { AttendanceReadDomainError } from "./attendance-read-domain";
import { EqualHandoverDomainError } from "./equal-technician-handover-domain";
import { EqualHandoverReportDomainError } from "./equal-handover-report-domain";
import { HandoverDomainError } from "./handover-domain";
import { HandoverReservationGuardError } from "./handover-reservation-guard-domain";
import { ShiftOperationsError } from "./shift-operations-domain";

// Shared §12 transport helpers for the v2 report routes. Every mutation
// derives its actor strictly from the verified session; request bodies never
// carry an actor UID.
export function handoverV2Enabled(): boolean {
  return process.env.HANDOVER_V2_DEV === "true";
}

export function respond(payload: Record<string, unknown>, status: number) {
  return NextResponse.json(payload, { status, headers: { "Cache-Control": "no-store" } });
}

export function routeFail(message: string, status: number): never {
  throw new AssignmentOperationError(message, status);
}

export function mapHandoverV2ReportError(error: unknown, fallback: string) {
  if (
    error instanceof AssignmentOperationError ||
    error instanceof HandoverDomainError ||
    error instanceof EqualHandoverDomainError ||
    error instanceof EqualHandoverReportDomainError ||
    error instanceof HandoverReservationGuardError ||
    error instanceof ShiftOperationsError ||
    error instanceof AttendanceReadDomainError ||
    error instanceof AttendanceEvidenceDomainError
  ) {
    return respond({ success: false, error: error.message }, error.status);
  }
  console.error(fallback, error);
  return respond({ success: false, error: "Unable to update the v2 handover report. Please try again." }, 500);
}

export function sameOrigin(request: NextRequest) {
  const expectedOrigin = process.env.APP_ORIGIN ?? request.nextUrl.origin;
  return request.headers.get("origin") === expectedOrigin;
}

function exactBody(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) routeFail("Invalid report request.", 400);
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some((key) => !fields.includes(key)) || fields.some((key) => !Object.hasOwn(data, key))) {
    routeFail("Missing or unsupported report request fields.", 400);
  }
  return data;
}

function requireHex64(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) routeFail(`Invalid ${label}.`, 400);
  return value;
}

function requireRevision(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) routeFail(`Invalid ${label}.`, 400);
  return value as number;
}

function requireUid(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.trim() !== value || value.length > 128 ||
      value.includes("/") || value === "." || value === "..") routeFail(`Invalid ${label}.`, 400);
  return value;
}

function requireReason(value: unknown, label: string, max = 2_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) routeFail(`A non-empty ${label} is required.`, 400);
  return value.trim();
}

function requireNullableCanonicalIso(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    routeFail(`Provide a canonical UTC ${label}.`, 400);
  }
  return value;
}

function requireNullableReason(value: unknown, label: string, max = 2_000): string | null {
  if (value === null) return null;
  return requireReason(value, label, max);
}

const bindingFields = ["expectedRevision", "expectedSnapshotHash"] as const;

function parseBinding(data: Record<string, unknown>) {
  return {
    expectedRevision: requireRevision(data.expectedRevision, "expected revision"),
    expectedSnapshotHash: requireHex64(data.expectedSnapshotHash, "expected snapshot hash"),
  };
}

export function parsePrepareBody(body: unknown): { reason: string | null } {
  const data = exactBody(body, ["reason"]);
  return { reason: requireNullableReason(data.reason, "preparation reason") };
}

export function parseAbsenceRecordBody(body: unknown) {
  const data = exactBody(body, ["technicianUid", "absenceType", "reason", "reportedDepartureTime", ...bindingFields]);
  if (data.absenceType !== "not_yet_in" && data.absenceType !== "absent_left_office") {
    routeFail("Unsupported absence type.", 400);
  }
  return {
    technicianUid: requireUid(data.technicianUid, "technician UID"),
    absenceType: data.absenceType as "not_yet_in" | "absent_left_office",
    reason: requireReason(data.reason, "absence reason", 1_000),
    reportedDepartureTime: requireNullableCanonicalIso(data.reportedDepartureTime, "reported departure time"),
    ...parseBinding(data),
  };
}

export function parseAbsenceClearBody(body: unknown) {
  const data = exactBody(body, ["technicianUid", ...bindingFields]);
  return { technicianUid: requireUid(data.technicianUid, "technician UID"), ...parseBinding(data) };
}

export function parseFreezeBody(body: unknown) {
  const data = exactBody(body, [
    ...bindingFields, "expectedGuardRevision", "expectedFencingEpoch", "preparationRevision",
    "contentDigest", "evidenceSnapshotHash", "workSnapshotVersion", "reason", "correctionNote",
  ]);
  return {
    ...parseBinding(data),
    expectedGuardRevision: requireRevision(data.expectedGuardRevision, "expected guard revision"),
    expectedFencingEpoch: requireRevision(data.expectedFencingEpoch, "expected fencing epoch"),
    preparationRevision: requireRevision(data.preparationRevision, "preparation revision"),
    contentDigest: requireHex64(data.contentDigest, "content digest"),
    evidenceSnapshotHash: requireHex64(data.evidenceSnapshotHash, "evidence snapshot hash"),
    workSnapshotVersion: requireHex64(data.workSnapshotVersion, "work snapshot version"),
    reason: requireReason(data.reason, "freeze reason", 1_000),
    correctionNote: requireNullableReason(data.correctionNote, "correction note", 4_000),
  };
}
