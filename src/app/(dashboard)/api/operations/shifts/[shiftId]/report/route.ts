import { NextRequest,NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { getHandoverReport } from "@/lib/operations/handover-report";
export const runtime="nodejs";
export async function GET(_request:NextRequest,context:{params:Promise<{shiftId:string}>}){
 try{const actor=await getCurrentUser();if(!actor)return NextResponse.json({success:false,error:"Authentication required."},{status:401});const {shiftId}=await context.params;return NextResponse.json({success:true,report:await getHandoverReport(actor,shiftId)},{headers:{"Cache-Control":"no-store"}});}
 catch(error){const status=error instanceof Error&&"status" in error&&typeof error.status==="number"?error.status:500;return NextResponse.json({success:false,error:status===500?"Report could not be retrieved.":(error as Error).message},{status,headers:{"Cache-Control":"no-store"}});}
}
