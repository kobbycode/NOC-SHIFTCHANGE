import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import {
  readEqualHandoverReportState,
  type EqualHandoverReportState,
} from "@/lib/operations/equal-handover-report-firestore";
import { readEqualHandoverInitiationContext } from "@/lib/operations/handover-initiation-v2";
import { EqualHandoverWorkflowV2 } from "@/components/operations/handover-workflow-v2";
import { EqualHandoverInitiationV2 } from "@/components/operations/handover-initiation-v2";
import { handoverV2AtomicAcceptanceEnabled } from "@/lib/operations/handover-v2-atomic-http";

export default async function V2HandoverReportPage({ params }: { params: Promise<{ shiftId: string }> }) {
  if (process.env.HANDOVER_V2_DEV !== "true") notFound();
  const actor = await getCurrentUser();
  if (!actor) return null;
  const { shiftId } = await params;
  let state: EqualHandoverReportState | null = null;
  let problem = "The v2 handover report is unavailable.";
  let reservationMissing = false;
  try {
    state = await readEqualHandoverReportState(shiftId, actor.uid);
  } catch (error) {
    const status = typeof error === "object" && error !== null && "status" in error
      ? (error as { status?: unknown }).status : undefined;
    if (typeof status === "number" && status >= 400 && status < 500 && error instanceof Error) {
      problem = error.message;
      reservationMissing = status === 404;
    }
  }
  // A 404 here means the shift has no v2 aggregate yet, which is exactly where
  // initiation belongs: an outgoing pair technician gets the begin/reserve
  // steps (both driven by the existing v2 routes), anyone else keeps the
  // plain "unavailable" response so no other shift's state is disclosed.
  if (state === null) {
    if (reservationMissing && actor.role === "technician") {
      const context = await readEqualHandoverInitiationContext(actor.uid, shiftId);
      if (context.isOutgoingTechnician) return <EqualHandoverInitiationV2 context={context} />;
    }
    return <div role="alert" className="rounded-xl border p-5 text-sm">{problem}</div>;
  }
  return <EqualHandoverWorkflowV2 uid={actor.uid} initialState={state} atomicAcceptanceEnabled={handoverV2AtomicAcceptanceEnabled()} />;
}
