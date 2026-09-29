import { NextResponse } from "next/server";

import {
  getCurrentUser,
} from "@/lib/auth/session";

import {
  AssignmentOperationError,
} from "@/lib/operations/assignment-transaction";

import {
  listTechnicianPairs,
} from "@/lib/operations/list-technician-pairs";

export const dynamic = "force-dynamic";

/**
 * Read the permanent technician-pair domain.
 *
 * Pair membership is an organizational
 * relationship only. It does not prove
 * attendance on any shift.
 *
 * This route intentionally exposes GET only.
 * Pair creation is not exposed here yet.
 */
export async function GET() {
  try {
    const user =
      await getCurrentUser();

    if (!user) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Authentication is required.",
        },
        {
          status: 401,
          headers: {
            "Cache-Control":
              "no-store",
          },
        }
      );
    }

    if (
      user.mustChangePassword === true
    ) {
      return NextResponse.json(
        {
          success: false,
          error:
            "You must change your password before continuing.",
        },
        {
          status: 403,
          headers: {
            "Cache-Control":
              "no-store",
          },
        }
      );
    }

    if (
      user.role !== "admin" &&
      user.role !== "supervisor"
    ) {
      return NextResponse.json(
        {
          success: false,
          error:
            "You are not authorized to retrieve technician pairs.",
        },
        {
          status: 403,
          headers: {
            "Cache-Control":
              "no-store",
          },
        }
      );
    }

    const pairs =
      await listTechnicianPairs({
        uid: user.uid,
        role: user.role,
      });

    return NextResponse.json(
      {
        success: true,
        pairs,
        total: pairs.length,
      },
      {
        status: 200,
        headers: {
          "Cache-Control":
            "no-store",
        },
      }
    );
  } catch (error) {
    if (
      error instanceof
      AssignmentOperationError
    ) {
      return NextResponse.json(
        {
          success: false,
          error: error.message,
        },
        {
          status: error.status,
          headers: {
            "Cache-Control":
              "no-store",
          },
        }
      );
    }

    console.error(
      "Failed to retrieve technician pairs:",
      error
    );

    return NextResponse.json(
      {
        success: false,
        error:
          "Unable to retrieve technician pairs.",
      },
      {
        status: 500,
        headers: {
          "Cache-Control":
            "no-store",
        },
      }
    );
  }
}