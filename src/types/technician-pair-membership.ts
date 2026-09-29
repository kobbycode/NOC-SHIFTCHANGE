/**
 * Concurrency-safe active permanent-pair reservation.
 *
 * Document ID must equal technicianUid.
 *
 * This record is an organizational pairing reservation only.
 * It is not shift attendance and must never be interpreted
 * as evidence that the technician joined or worked a shift.
 */
export interface TechnicianPairMembership {
  technicianUid: string;

  pairId: string;

  createdAt: string;
  updatedAt: string;
}
