import "server-only";

import { NextResponse } from "next/server";

import {
  getCurrentUser,
} from "@/lib/auth/session";

import {
  getAdminFirestore,
} from "@/lib/firebase/admin";

import {
  evaluateAssignmentEligibility,
} from "@/lib/operations/assignment-eligibility";

import {
  getOperationalCollections,
} from "@/lib/operations/collections";

export const runtime = "nodejs";

export const dynamic = "force-dynamic";

interface EligibleTechnician {
  uid: string;
  fullName: string;
}

/**
 * ShiftChange 2.0
 *
 * Authoritative technician-selection API.
 *
 * GET /api/operations/technicians/eligible
 *
 * Read-only.
 *
 * Permanent-pair selection additionally excludes
 * technicians that already have an authoritative
 * technician_pair_memberships reservation.
 *
 * Pair creation still revalidates the reservation
 * transactionally, so this read path is not relied
 * upon as the concurrency boundary.
 *
 * Permanent account revocation remains disabled.
 */

export async function GET() {
  try {
    /*
     * PHASE 1:
     * Authenticate the acting user.
     */

    const actor = await getCurrentUser();

    if (!actor) {
      return NextResponse.json(
        {
          success: false,
          error: "Authentication is required.",
        },
        {
          status: 401,
        }
      );
    }

    /*
     * PHASE 2:
     * Enforce supervisor/admin authorization.
     */

    if (
      actor.mustChangePassword ||
      !["admin", "supervisor"].includes(
        actor.role
      )
    ) {
      return NextResponse.json(
        {
          success: false,
          error:
            "You are not authorized to retrieve eligible technicians.",
        },
        {
          status: 403,
        }
      );
    }

    /*
     * PHASE 3:
     * Revalidate the acting account.
     */

    const db = getAdminFirestore();

    const actorSnapshot = await db
      .collection("users")
      .doc(actor.uid)
      .get();

    const actorProfile =
      actorSnapshot.data();

    if (
      !actorSnapshot.exists ||
      !actorProfile ||
      actorProfile.status !== "active" ||
      actorProfile.statusOperation != null ||
      actorProfile.mustChangePassword === true ||
      actorProfile.role !== actor.role
    ) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Your account is not authorized to retrieve eligible technicians.",
        },
        {
          status: 403,
        }
      );
    }

    /*
     * PHASE 4:
     * Retrieve technician accounts and current
     * permanent-pair reservations.
     *
     * The reservation document ID is the technician UID.
     * Pair membership is organizational configuration,
     * not attendance or shift participation.
     */

    const {
      technicianPairMemberships,
    } = getOperationalCollections();

    const [
      snapshot,
      pairMembershipSnapshot,
    ] = await Promise.all([
      db
        .collection("users")
        .where("role", "==", "technician")
        .get(),

      technicianPairMemberships.get(),
    ]);

    const reservedTechnicianUids =
      new Set(
        pairMembershipSnapshot.docs.map(
          (document) => document.id
        )
      );

    /*
     * PHASE 5:
     * Apply the existing authoritative account /
     * assignment eligibility rules, then exclude
     * technicians already reserved to a permanent pair.
     *
     * Do not move pair membership into
     * evaluateAssignmentEligibility(): permanent-pair
     * membership must not make a technician generally
     * ineligible for operational task assignments.
     */

    const technicians: EligibleTechnician[] =
      [];

    for (const document of snapshot.docs) {
      const profile = document.data();

      const eligibility =
        evaluateAssignmentEligibility(
          profile
        );

      if (!eligibility.eligible) {
        continue;
      }

      if (
        reservedTechnicianUids.has(
          document.id
        )
      ) {
        continue;
      }

      technicians.push({
        uid: document.id,

        fullName:
          typeof profile.fullName === "string" &&
          profile.fullName.trim().length > 0
            ? profile.fullName.trim()
            : "Unnamed technician",
      });
    }

    /*
     * PHASE 6:
     * Sort technicians alphabetically.
     */

    technicians.sort(
      (a, b) =>
        a.fullName.localeCompare(
          b.fullName
        )
    );

    /*
     * PHASE 7:
     * Return minimal technician data.
     */

    return NextResponse.json(
      {
        success: true,
        technicians,
        total: technicians.length,
      },
      {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
        },
      }
    );
  } catch (error) {
    console.error(
      "Eligible technician retrieval failed:",
      error
    );

    return NextResponse.json(
      {
        success: false,
        error:
          "Eligible technicians could not be retrieved.",
      },
      {
        status: 500,
      }
    );
  }
}
