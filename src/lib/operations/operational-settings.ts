import "server-only";

import type { AppUser } from "@/types/auth";

import { DEFAULT_BROADCAST_STATIONS } from "@/types/shift-operations";

import { getOperationalCollections, GLOBAL_OPERATIONAL_SHIFT_CONTROL_ID } from "./collections";

import { assertOperationalShiftControl } from "./operational-shift-control-state";

import { requireReadProfile } from "./read-guard";

const MAX_STATIONS = 30;

export interface OperationalSettingsView {
  control: {
    state: "no_current_shift" | "current_shift" | "needs_review" | "not_initialized";
    generation: number | null;
    shift: {
      shiftType: string;
      status: string;
      scheduledStart: string;
      scheduledEnd: string;
      actualStart: string | null;
    } | null;
    consumedAt: string | null;
  };
  workforce: {
    total: number;
    active: number;
    admins: number;
    supervisors: number;
    technicians: number;
  };
  stations: {
    configured: boolean;
    total: number;
    enabled: number;
    max: number;
    invalid: number;
    belowMinimum: boolean;
  };
}

export async function getOperationalSettings(
  actor: AppUser,
): Promise<OperationalSettingsView> {
  await requireReadProfile(actor, ["admin"]);

  const { db, operationalShiftControl, shifts } = getOperationalCollections();

  const [controlSnapshot, userSnapshot, stationSnapshot] = await Promise.all([
    operationalShiftControl.doc(GLOBAL_OPERATIONAL_SHIFT_CONTROL_ID).get(),
    db.collection("users").get(),
    db.collection("broadcast_stations").get(),
  ]);

  let controlState: OperationalSettingsView["control"] = {
    state: "not_initialized",
    generation: null,
    shift: null,
    consumedAt: null,
  };

  if (controlSnapshot.exists) {
    try {
      const control = assertOperationalShiftControl(controlSnapshot.data());

      if (control.slotStatus === "pending" || !control.shiftId) {
        controlState = {
          state: "no_current_shift",
          generation: control.generation,
          shift: null,
          consumedAt: null,
        };
      } else {
        const shiftSnapshot = await shifts.doc(control.shiftId).get();
        const shift = shiftSnapshot.data();

        if (
          !shiftSnapshot.exists ||
          !shift ||
          shift.id !== control.shiftId ||
          shift.status !== control.shiftStatus
        ) {
          controlState = {
            state: "needs_review",
            generation: control.generation,
            shift: null,
            consumedAt: control.consumedAt,
          };
        } else {
          controlState = {
            state: "current_shift",
            generation: control.generation,
            shift: {
              shiftType: String(shift.shiftType),
              status: String(shift.status),
              scheduledStart: String(shift.scheduledStart),
              scheduledEnd: String(shift.scheduledEnd),
              actualStart: typeof shift.actualStart === "string" ? shift.actualStart : null,
            },
            consumedAt: control.consumedAt,
          };
        }
      }
    } catch {
      controlState = {
        state: "needs_review",
        generation: null,
        shift: null,
        consumedAt: null,
      };
    }
  }

  const workforce = {
    total: userSnapshot.size,
    active: 0,
    admins: 0,
    supervisors: 0,
    technicians: 0,
  };

  for (const document of userSnapshot.docs) {
    const data = document.data();

    if (data.status === "active") workforce.active += 1;

    if (data.role === "admin") workforce.admins += 1;
    else if (data.role === "supervisor") workforce.supervisors += 1;
    else if (data.role === "technician") workforce.technicians += 1;
  }

  let invalid = 0;
  let enabled = 0;
  const configured = stationSnapshot.size > 0;

  if (configured) {
    for (const document of stationSnapshot.docs) {
      const data = document.data();
      const name = typeof data.name === "string" ? data.name.trim() : "";

      if (
        data.id !== document.id ||
        !name ||
        name.length > 100 ||
        typeof data.enabled !== "boolean"
      ) {
        invalid += 1;
        continue;
      }

      if (data.enabled) enabled += 1;
    }
  } else {
    enabled = DEFAULT_BROADCAST_STATIONS.length;
  }

  return {
    control: controlState,
    workforce,
    stations: {
      configured,
      total: configured ? stationSnapshot.size : DEFAULT_BROADCAST_STATIONS.length,
      enabled,
      max: MAX_STATIONS,
      invalid,
      belowMinimum: enabled < 1 || enabled > MAX_STATIONS,
    },
  };
}
