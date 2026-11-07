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

// Shared §12 transport helpers for the v2 report routes. Every mutation derives
// its acting authority from the verified session, and no body names its actor
// (an absence declaration names its SUBJECT, never the acting colleague). The
// one body that names the acting technician is the shared-console incoming
// acceptance: it names the reserved incoming technician whose OWN password is
// verified before that person becomes the session.
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

function exactBody(
  value: unknown,
  fields: readonly string[],
  optionalFields: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) routeFail("Invalid report request.", 400);
  const data = value as Record<string, unknown>;
  if (
    Object.keys(data).some((key) => !fields.includes(key)) ||
    fields.some((key) => !optionalFields.includes(key) && !Object.hasOwn(data, key))
  ) {
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

// The verified session proves who the actor is; the password proves they are
// present now. It is read only to reauthenticate inside the route handler and
// is never passed to a service, persisted, logged or echoed.
function requirePersonalPassword(data: Record<string, unknown>, action: string): { password: string } {
  if (typeof data.password !== "string" || data.password.length === 0) {
    routeFail(`Your password is required to ${action}.`, 400);
  }
  return { password: data.password };
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

// A confirmation is a personal act: the confirming participant is the
// authenticated session actor and must reauthenticate with their OWN current
// password, which the trusted coordinator verifies server-side before the
// transaction and never stores or logs. The body carries no technician UID,
// role or timestamp — only the reviewed binding and the password.
export function parseConfirmBody(body: unknown) {
  const data = exactBody(body, [...bindingFields, "password"]);
  return { ...requirePersonalPassword(data, "confirm this handover"), ...parseBinding(data) };
}

// The final transfer, outgoing commit and incoming acceptance all bind to the
// same four concurrency values the reviewed evidence carried. They carry no
// actor, role, evidence kind or timestamp — those are derived strictly from the
// verified session inside the service (§4). Acceptance alone also names the
// reserved incoming technician accepting on the shared console, because the
// console session is not that person until their own password is verified.
const transferBindingFields = [
  ...bindingFields, "expectedGuardRevision", "expectedFencingEpoch",
] as const;

function parseTransferBinding(data: Record<string, unknown>) {
  return {
    ...parseBinding(data),
    expectedGuardRevision: requireRevision(data.expectedGuardRevision, "expected guard revision"),
    expectedFencingEpoch: requireRevision(data.expectedFencingEpoch, "expected fencing epoch"),
  };
}

// Outgoing commit: a personally confirmed outgoing technician closes the
// handover into `awaiting_incoming_acceptance`. Closing a handover is an
// outgoing action taken as that person, so it requires the actor's own current
// password alongside the reviewed binding.
export function parseCommitBody(body: unknown) {
  const data = exactBody(body, [...transferBindingFields, "password"]);
  return {
    ...requirePersonalPassword(data, "commit this handover"),
    ...parseTransferBinding(data),
  };
}

// Incoming acceptance on a shared console: the body names WHICH reserved incoming
// technician is accepting and carries that person's own current password, which
// proves they are present now. The named UID confers no authority by itself — the
// server constrains it to this handover's incoming roster and verifies that
// person's credential before anything is written. No role, evidence kind or
// timestamp may be injected, and the password is verified server-side before the
// transaction and never stored or logged.
export function parseAcceptBody(body: unknown) {
  const data = exactBody(
    body,
    [...transferBindingFields, "technicianUid", "password", "locationEvidence"],
    ["locationEvidence"],
  );
  return {
    technicianUid: requireUid(data.technicianUid, "accepting technician UID"),
    ...requirePersonalPassword(data, "accept this handover"),
    ...parseTransferBinding(data),
    // Untrusted coarse browser evidence; the route normalizes it against the
    // server clock and it never blocks an acceptance.
    locationEvidence: data.locationEvidence,
  };
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
