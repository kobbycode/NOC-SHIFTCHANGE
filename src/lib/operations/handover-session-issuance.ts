import "server-only";

import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminAuth, getAdminFirestore } from "@/lib/firebase/admin";
import { SESSION_DURATION_MS } from "@/lib/auth/session-cookie";

export interface HandoverSessionIssuanceInput {
  outgoingShiftId: string;
  handoverDocumentId: string;
  acceptingTechnicianUid: string;
  consoleActorUid: string;
  outgoingTechnicianIds: readonly string[];
  // One-shot credential from authenticatePasswordForSession, exchanged for a
  // session cookie here. Never persisted, logged, echoed or returned.
  idToken: string;
  firstActivation: boolean;
  acceptanceReceiptId: string | null;
  nowIso: string;
}

export interface HandoverSessionIssuanceResult {
  sessionCookie: string | null;
  issued: boolean;
  issuanceId: string;
  issuanceRecorded: boolean;
  replayed: boolean;
  // What THIS request revoked. The outgoing pair is revoked once, on the first
  // committed acceptance; a later join or replay revokes nothing, so an empty
  // list here is not evidence that the outgoing sessions are still live.
  revokedOutgoingTechnicianUids: string[];
  outgoingSessionsRevoked: boolean;
}

export function handoverSessionIssuanceId(handoverDocumentId: string, acceptingTechnicianUid: string): string {
  return `handover-session-v2-${createHash("sha256")
    .update(JSON.stringify({
      namespace: "equal-handover-session-v2",
      handoverDocumentId,
      acceptingTechnicianUid,
    }))
    .digest("hex")}`;
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code: unknown }).code === 6;
}

// The shared post-commit step for BOTH acceptance writers (legacy and atomic).
// It runs only after the acceptance transaction has committed, never inside it,
// and it cannot un-commit or invalidate an accepted handover: every stage is
// independently guarded and reports what actually happened.
//
// Order matters. The incoming technician's cookie is minted FIRST so that a
// revocation failure can never leave the on-shift technician unable to sign in.
// The outgoing pair is revoked only on the first committed acceptance — they are
// distinct from every incoming participant by the reservation domain, so this
// can never revoke the session just issued. A replay re-mints a cookie for the
// same verified technician without rewriting the issuance record.
export async function issueIncomingHandoverSession(
  input: HandoverSessionIssuanceInput,
): Promise<HandoverSessionIssuanceResult> {
  const issuanceId = handoverSessionIssuanceId(input.handoverDocumentId, input.acceptingTechnicianUid);

  let sessionCookie: string | null = null;
  try {
    sessionCookie = await getAdminAuth().createSessionCookie(input.idToken, { expiresIn: SESSION_DURATION_MS });
  } catch {
    // The upstream exception can carry credential material; never log it.
    console.error("Handover acceptance committed but its incoming session could not be issued.");
  }

  const revokedOutgoingTechnicianUids: string[] = [];
  if (input.firstActivation) {
    for (const uid of input.outgoingTechnicianIds) {
      try {
        await getAdminAuth().revokeRefreshTokens(uid);
        revokedOutgoingTechnicianUids.push(uid);
      } catch {
        console.error("Handover acceptance committed but an outgoing session could not be revoked.");
      }
    }
  }

  let issuanceRecorded = false;
  let replayed = false;
  try {
    await getAdminFirestore().collection("audit_logs").doc(issuanceId).create({
      id: issuanceId,
      schema: "handover-session-issuance-v2",
      action: "HANDOVER_SESSION_ISSUED_V2",
      protocol: "equal-handover-v2",
      handoverDocumentId: input.handoverDocumentId,
      outgoingShiftId: input.outgoingShiftId,
      acceptingTechnicianUid: input.acceptingTechnicianUid,
      consoleActorUid: input.consoleActorUid,
      outgoingTechnicianIds: [...input.outgoingTechnicianIds],
      revokedOutgoingTechnicianUids,
      firstActivation: input.firstActivation,
      acceptanceReceiptId: input.acceptanceReceiptId,
      issuedAt: input.nowIso,
      createdAt: FieldValue.serverTimestamp(),
    });
    issuanceRecorded = true;
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      issuanceRecorded = true;
      replayed = true;
    } else {
      console.error("Handover acceptance committed but its session issuance record could not be written.");
    }
  }

  return {
    sessionCookie,
    issued: sessionCookie !== null,
    issuanceId,
    issuanceRecorded,
    replayed,
    revokedOutgoingTechnicianUids,
    outgoingSessionsRevoked:
      input.firstActivation && revokedOutgoingTechnicianUids.length === input.outgoingTechnicianIds.length,
  };
}