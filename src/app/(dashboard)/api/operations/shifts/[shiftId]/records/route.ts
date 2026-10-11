import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { getShiftOperations, recordShiftOperation } from "@/lib/operations/shift-operations";
import { ShiftOperationsError } from "@/lib/operations/shift-operations-domain";
export const runtime="nodejs";
type Context={params:Promise<{shiftId:string}>};
async function handle(request:NextRequest,context:Context,write:boolean) {
  const response=(data:unknown,status=200)=>NextResponse.json(data,{status,headers:{"Cache-Control":"no-store"}});
  try {
    const actor=await getCurrentUser();
    if (!actor) return response({success:false,error:"Sign in to continue."},401);
    if(actor.mustChangePassword) return response({success:false,error:"Change your initial password first."},403);
    if(write && request.headers.get("origin") !== (process.env.APP_ORIGIN ?? request.nextUrl.origin)) return response({success:false,error:"This request is not allowed."},403);
    const {shiftId}=await context.params;
    if(write) {
      let body:unknown;try {body=await request.json();}catch {return response({success:false,error:"Provide valid JSON."},400);}
      const event=await recordShiftOperation(actor,shiftId,body);return response({success:true,event},201);
    }
    return response({success:true,operations:await getShiftOperations(actor,shiftId)});
  }catch(error) {
    if(error instanceof ShiftOperationsError) return response({success:false,error:error.message},error.status);
    // Existing authorization domain errors carry an HTTP status.
    if(error instanceof Error && "status" in error && typeof error.status === "number") return response({success:false,error:error.message},error.status);
    console.error("Shift operations failed",error);return response({success:false,error:"Shift operations could not be processed."},500);
  }
}
export async function GET(request:NextRequest,context:Context){return handle(request,context,false);}
export async function POST(request:NextRequest,context:Context){return handle(request,context,true);}
