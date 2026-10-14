import type { EmailReservationKey } from "./account-provisioning-domain";
import { createHmac } from "crypto";

export type ReservationKeyVersion = "v1" | "v2" | "v3";

export interface ReservationKeyConfig {
  secret: string;
  version?: ReservationKeyVersion;
}

export function computeEmailReservationKey(
  email: string,
  config: ReservationKeyConfig,
): EmailReservationKey {
  const { secret, version = "v1" } = config;

  if (typeof secret !== "string" || secret.trim().length === 0) {
    throw new Error(
      "Reservation key secret must be a non-empty string.",
    );
  }

  const normalizedEmail = email.trim().toLowerCase();

  const hmac = createHmac("sha256", secret).update(normalizedEmail).digest("hex");

  return `hmac-sha256:${version}:${hmac}` as EmailReservationKey;
}

export function validateReservationKey(
  key: string,
): { version: ReservationKeyVersion; opaqueKey: string } | null {
  const match = key.match(/^hmac-sha256:(v1|v2|v3):([0-9a-f]{64})$/);
  if (!match) return null;
  return { version: match[1] as ReservationKeyVersion, opaqueKey: match[2] };
}
