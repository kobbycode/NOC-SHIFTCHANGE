import type { Attendance } from "./attendance";
import type { HandoverAggregate, HandoverParticipant, HandoverWorkSnapshot } from "./handover";
import type { ShiftOperationsView } from "./shift-operations";
export interface HandoverReportContent {
  schema:"handover-report-v1";
  staff:{shiftId:string;shiftDate:string;shiftType:string;scheduledStart:string;scheduledEnd:string;actualStart:string|null;
    engineeringLocation:string|null;outgoing:{uid:string;name:string|null}[];incoming:{uid:string;name:string|null}[];incomingShiftId:string|null;handoverStartedAt:string|null};
  attendance:{uid:string;name:string|null;evidence:Attendance|null;reportingTime:string|null;hoursWorked:number|null;lateReason:string|null}[];
  operations:ShiftOperationsView;
  pendingTasks:{id:string;title:string;priority:string;status:string;assignments:{id:string;technicianUid:string;responsibility:string;acceptance:string;responsibilityStatus:string}[];
    disposition:string;reason:string|null;carryForwardEligible:boolean}[];
  workSnapshot:HandoverWorkSnapshot;
  completeness:{blockers:string[];warnings:string[]};
  corrections:{id:string;note:string;recordedBy:string;recordedAt:string}[];
}
export interface HandoverReportView {
  content:HandoverReportContent;
  handover:HandoverAggregate|null;
  participants:HandoverParticipant[];
  snapshotHash:string|null;
  receipt:Record<string,unknown>|null;
  frozen:boolean;
}
export interface HandoverReportBinding {schema:"handover-report-v1";id:string;digest:string;}
export interface FrozenHandoverReport {
  id:string;schema:"handover-report-v1";outgoingShiftId:string;digest:string;content:HandoverReportContent;
  frozenBy:string;frozenAt:string;reason:string;reviewedRevision:number;
}
