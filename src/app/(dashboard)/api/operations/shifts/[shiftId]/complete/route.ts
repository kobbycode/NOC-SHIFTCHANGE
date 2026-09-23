import "server-only";

import { NextRequest, NextResponse, } from "next/server";

import { getCurrentUser, } from "@/lib/auth/session";

import { completeShift, } from "@/lib/operations/complete-shift";

import { AssignmentOperationError, } from "@/lib/operations/assignment-transaction";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ shiftId: string; }>; };

function errorResponse( message: string, status: number ) { return NextResponse.json( { success: false, error: message, }, { status, } ); }

export async function POST( request: NextRequest, context: RouteContext ) { /*

* Authenticate the current session. */

const actor = await getCurrentUser();

if (!actor) { return errorResponse( "Please sign in to continue.", 401 ); }

/*

Only administrators and supervisors

may complete shift handover. */

if ( actor.role !== "admin" && actor.role !== "supervisor" ) { return errorResponse( "Your account is not authorized to complete shift handover.", 403 ); }

if (actor.mustChangePassword) { return errorResponse( "Please complete your password change before continuing.", 403 ); }

/*

* Validate the shift identifier. */

const { shiftId } = await context.params;

if ( !shiftId || shiftId.includes("/") || shiftId.length > 512 ) { return errorResponse( "Please provide a valid shift.", 400 ); }

/*

Use the authenticated session

as the source of actor identity. */

try { const result = await completeShift({ shiftId, actorUid: actor.uid, });

return NextResponse.json( { success: true,

message: "Shift completed successfully.",

shift: { id: result.shiftId,

status: result.status,

actualEnd: result.actualEnd, }, }, { status: 200, } ); } catch (error) { if ( error instanceof AssignmentOperationError ) { return errorResponse( error.message, error.status ); }

console.error( "Shift completion failed:", error );

return errorResponse( "Shift completion could not be completed. Please try again.", 500 ); } }