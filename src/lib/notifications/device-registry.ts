// TECH-HO-RECOVERY-09L — push device registry (server-only, admin Firestore).
//
// A device is identified by its browser installation. Exactly one technician is
// bound to an installation at a time; a shared-device account switch overwrites
// (deactivates) the previous technician's binding for that installation before
// registering the next. The authenticated uid is supplied by the caller after
// requireUser(["technician"]) — a client can never register a token against
// someone else's identity.
import "server-only";
import { getOperationalCollections } from "@/lib/operations/collections";
import { documentIdForKey, tokenHash, tokenFingerprint } from "./notification-domain";
import type { DeviceRegistration } from "@/types/notification";

function deviceDocumentId(installationId: string): string {
  return documentIdForKey(`device:${installationId}`);
}

function assertSafe(value: string, max: number, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || value.trim() !== value) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

export interface RegisterDeviceInput {
  uid: string;
  installationId: string;
  token: string;
  platform: string;
  now: string;
}

// Returns a non-sensitive device reference (the token hash). The raw token is
// never returned to the caller.
export async function registerDevice(input: RegisterDeviceInput): Promise<{ deviceRef: string }> {
  const uid = assertSafe(input.uid, 128, "uid");
  const installationId = assertSafe(input.installationId, 128, "installation id");
  const token = assertSafe(input.token, 8192, "device token");
  const platform = assertSafe(String(input.platform ?? "").slice(0, 64) || "unknown", 64, "platform");
  const now = assertSafe(input.now, 64, "timestamp");

  const { db } = getOperationalCollections();
  const ref = db.collection("device_registrations").doc(deviceDocumentId(installationId));

  await db.runTransaction(async (transaction) => {
    const existing = await transaction.get(ref);
    const previous = existing.exists ? (existing.data() as DeviceRegistration) : undefined;
    // Same token re-registered for the same technician keeps its original
    // registeredAt; a different uid on this installation replaces (deactivates)
    // the previous technician's binding as part of the account switch.
    const sameBinding = !!previous && previous.uid === uid && previous.token === token;
    const record: DeviceRegistration = {
      schema: "device-registration-v1",
      uid,
      installationId,
      token,
      tokenHash: tokenHash(token),
      tokenFingerprint: tokenFingerprint(token),
      platform,
      active: true,
      registeredAt: sameBinding && previous ? previous.registeredAt : now,
      updatedAt: now,
      deactivatedAt: null,
      deactivationReason: null,
    };
    transaction.set(ref, record);
  });

  return { deviceRef: tokenHash(token) };
}

export interface DeactivateDeviceInput {
  installationId: string;
  uid: string;
  reason: string;
  now: string;
}

// Deactivates the CURRENT authenticated technician's binding for this
// installation (used on explicit sign-out of a device). Never touches another
// technician's devices.
export async function deactivateDevice(input: DeactivateDeviceInput): Promise<void> {
  const installationId = assertSafe(input.installationId, 128, "installation id");
  const uid = assertSafe(input.uid, 128, "uid");
  const { db } = getOperationalCollections();
  const ref = db.collection("device_registrations").doc(deviceDocumentId(installationId));
  await db.runTransaction(async (transaction) => {
    const existing = await transaction.get(ref);
    if (!existing.exists) return;
    const current = existing.data() as DeviceRegistration;
    if (current.uid !== uid) return; // never deactivate another technician's device
    transaction.set(ref, {
      ...current,
      active: false,
      updatedAt: input.now,
      deactivatedAt: input.now,
      deactivationReason: input.reason.slice(0, 128),
    });
  });
}

// Invalid-token cleanup performed by the delivery worker when FCM reports the
// token is unregistered. Deactivates every active binding that presents the
// token, across technicians (a token belongs to one installation).
export async function deactivateByToken(token: string, now: string): Promise<number> {
  if (typeof token !== "string" || !token) return 0;
  const hash = tokenHash(token);
  const { db } = getOperationalCollections();
  const snapshot = await db
    .collection("device_registrations")
    .where("tokenHash", "==", hash)
    .where("active", "==", true)
    .get();
  let count = 0;
  for (const doc of snapshot.docs) {
    await doc.ref.set(
      { ...(doc.data() as DeviceRegistration), active: false, updatedAt: now, deactivatedAt: now, deactivationReason: "invalid_token" },
      { merge: true },
    );
    count += 1;
  }
  return count;
}

// Active devices for one technician (used by the delivery worker).
export async function listActiveDevicesForUid(uid: string): Promise<DeviceRegistration[]> {
  const { db } = getOperationalCollections();
  const snapshot = await db
    .collection("device_registrations")
    .where("uid", "==", uid)
    .where("active", "==", true)
    .get();
  return snapshot.docs.map((doc) => doc.data() as DeviceRegistration);
}
