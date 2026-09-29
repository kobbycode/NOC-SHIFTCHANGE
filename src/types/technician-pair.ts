export const TECHNICIAN_PAIR_STATUSES = {
  ACTIVE: "active",
  INACTIVE: "inactive",
} as const;

export type TechnicianPairStatus =
  (typeof TECHNICIAN_PAIR_STATUSES)[keyof typeof TECHNICIAN_PAIR_STATUSES];

/**
 * Permanent organizational relationship between exactly two technicians.
 *
 * Important:
 * - technicianIds contains exactly two distinct technician UIDs.
 * - Array position does not imply ownership, seniority, or attendance.
 * - Pair membership does not prove participation in any particular shift.
 * - Historical shifts must snapshot their own pair/technician information
 *   rather than depending on the pair remaining active forever.
 */
export interface TechnicianPair {
  id: string;

  technicianIds: [string, string];

  status: TechnicianPairStatus;

  createdBy: string;
  createdAt: string;
  updatedAt: string;

  deactivatedAt: string | null;
  deactivatedBy: string | null;
}
