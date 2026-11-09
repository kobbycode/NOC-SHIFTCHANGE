import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { getSupervisorV2HandoverDetail } from "@/lib/operations/supervisor-handover-v2";
import { SupervisorHandoverV2Detail } from "@/components/operations/supervisor-handover-v2-detail";
import { handoverV2AtomicAcceptanceEnabled } from "@/lib/operations/handover-v2-atomic-http";

export default async function SupervisorV2HandoverDetailPage({ params }: { params: Promise<{ shiftId: string }> }) {
  if (process.env.HANDOVER_V2_DEV !== "true") notFound();
  const actor = await getCurrentUser();
  if (!actor) return null;
  const { shiftId } = await params;

  let view: Awaited<ReturnType<typeof getSupervisorV2HandoverDetail>> | null = null;
  let problem = "The v2 handover report is unavailable.";
  try {
    view = await getSupervisorV2HandoverDetail(actor, shiftId);
  } catch (error) {
    const status = typeof error === "object" && error !== null && "status" in error
      ? (error as { status?: unknown }).status : undefined;
    if (typeof status === "number" && status >= 400 && status < 500 && error instanceof Error) {
      problem = error.message;
    }
  }

  if (view === null) {
    return <main className="mx-auto max-w-2xl p-6">
      <div role="alert" className="rounded-xl border p-5 text-sm">{problem}</div>
    </main>;
  }
  return (
    <SupervisorHandoverV2Detail
      view={view}
      atomicAcceptanceEnabled={handoverV2AtomicAcceptanceEnabled()}
      recovery={{
        handoverDocumentId: view.state.live.content.handoverDocumentId,
        actorUid: actor.uid,
      }}
    />
  );
}
