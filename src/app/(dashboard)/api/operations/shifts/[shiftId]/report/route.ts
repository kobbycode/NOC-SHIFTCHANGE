import { NextRequest,NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { getHandoverReport } from "@/lib/operations/handover-report";
import { freezeHandoverReport } from "@/lib/operations/freeze-handover-report";
export const runtime="nodejs";
export async function GET(_request:NextRequest,context:{params:Promise<{shiftId:string}>}){
 try{const actor=await getCurrentUser();if(!actor)return NextResponse.json({success:false,error:"Authentication required."},{status:401});const {shiftId}=await context.params;return NextResponse.json({success:true,report:await getHandoverReport(actor,shiftId)},{headers:{"Cache-Control":"no-store"}});}
 catch(error){const status=error instanceof Error&&"status" in error&&typeof error.status==="number"?error.status:500;return NextResponse.json({success:false,error:status===500?"Report could not be retrieved.":(error as Error).message},{status,headers:{"Cache-Control":"no-store"}});}
}
export async function POST(request:NextRequest,context:{params:Promise<{shiftId:string}>}){
 const response=(data:unknown,status=200)=>NextResponse.json(data,{status,headers:{"Cache-Control":"no-store"}});
 try{const actor=await getCurrentUser();if(!actor)return response({success:false,error:"Authentication required."},401);
  if(actor.mustChangePassword||request.headers.get("origin")!==(process.env.APP_ORIGIN??request.nextUrl.origin))return response({success:false,error:"Request not allowed."},403);
  const {shiftId}=await context.params;let body:unknown;try{body=await request.json();}catch{return response({success:false,error:"Invalid JSON."},400);}
  return response({success:true,binding:await freezeHandoverReport(actor,shiftId,body)});
 }catch(error){const status=error instanceof Error&&"status" in error&&typeof error.status==="number"?error.status:500;return response({success:false,error:status===500?"Report freeze failed.":(error as Error).message},status);}
}
