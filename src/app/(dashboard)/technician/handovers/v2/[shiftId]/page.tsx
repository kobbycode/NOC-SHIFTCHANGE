import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import {
  readEqualHandoverReportState,
  type EqualHandoverReportState,
} from "@/lib/operations/equal-handover-report-firestore";
import { EqualHandoverWorkflowV2 } from "@/components/operations/handover-workflow-v2";

export default async function V2HandoverReportPage({ params }: { params: Promise<{ shiftId: string }> }) {
  if (process.env.HANDOVER_V2_DEV !== "true") notFound();
  const actor = await getCurrentUser();
  if (!actor) return null;
  const { shiftId } = await params;
  let state: EqualHandoverReportState | null = null;
  let problem = "The v2 handover report is unavailable.";
  try {
    state = await readEqualHandoverReportState(shiftId, actor.uid);
  } catch (error) {
    const status = typeof error === "object" && error !== null && "status" in error
      ? (error as { status?: unknown }).status : undefined;
    if (typeof status === "number" && status >= 400 && status < 500 && error instanceof Error) problem = error.message;
  }
  if (state === null) return <div role="alert" className="rounded-xl border p-5 text-sm">{problem}</div>;
  return <EqualHandoverWorkflowV2 uid={actor.uid} initialState={state} />;
}
