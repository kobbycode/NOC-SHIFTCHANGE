
import "server-only";

import {
  NextRequest,
  NextResponse,
} from "next/server";

import {
  getCurrentUser,
} from "@/lib/auth/session";

import {
  createTask,
} from "@/lib/operations/create-task";

import {
  AssignmentOperationError,
} from "@/lib/operations/assignment-transaction";

import {
  TASK_PRIORITIES,
  type TaskPriority,
} from "@/types/task";

export const runtime = "nodejs";

function isTaskPriority(
  value: unknown
): value is TaskPriority {
  return (
    typeof value === "string" &&
    Object.values(
      TASK_PRIORITIES
    ).some(
      (priority) =>
        priority === value
    )
  );
}

export async function POST(
  request: NextRequest
) {
  /*
   * PHASE 1:
   * Authenticate the request.
   */

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
      }
    );
  }

  if (
    user.mustChangePassword ||
    ![
      "admin",
      "supervisor",
    ].includes(user.role)
  ) {
    return NextResponse.json(
      {
        success: false,
        error:
          "You are not authorized to create tasks.",
      },
      {
        status: 403,
      }
    );
  }

  /*
   * PHASE 2:
   * Validate the request body.
   */

  let body: unknown;

  try {
    body =
      await request.json();
  } catch {
    return NextResponse.json(
      {
        success: false,
        error:
          "Please provide a valid JSON request body.",
      },
      {
        status: 400,
      }
    );
  }

  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body)
  ) {
    return NextResponse.json(
      {
        success: false,
        error:
          "Please provide valid task details.",
      },
      {
        status: 400,
      }
    );
  }

  const data =
    body as Record<
      string,
      unknown
    >;

  if (
    typeof data.title !==
      "string" ||
    typeof data.description !==
      "string" ||
    !isTaskPriority(
      data.priority
    ) ||
    (
      data.sectionId !==
        undefined &&
      data.sectionId !== null &&
      typeof data.sectionId !==
        "string"
    ) ||
    (
      data.shiftId !==
        undefined &&
      data.shiftId !== null &&
      typeof data.shiftId !==
        "string"
    )
  ) {
    return NextResponse.json(
      {
        success: false,
        error:
          "Please provide valid task details.",
      },
      {
        status: 400,
      }
    );
  }

  /*
   * PHASE 3:
   * Execute the server-side
   * task creation service.
   */

  try {
    const task =
      await createTask({
        title:
          data.title as string,

        description:
          data.description as string,

        priority:
          data.priority,

        sectionId:
          (data.sectionId as
            string | null | undefined) ??
          null,

        shiftId:
          (data.shiftId as
            string | null | undefined) ??
          null,

        createdBy:
          user.uid,
      });

    return NextResponse.json(
      {
        success: true,

        message:
          "Task created successfully.",

        task,
      },
      {
        status: 201,
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
      }
    );
  }

  console.error(
    "Task creation failed:",
    error
  );

  return NextResponse.json(
    {
      success: false,
      error:
        "The task could not be created.",
    },
    {
      status: 500,
    }
  );
}
}