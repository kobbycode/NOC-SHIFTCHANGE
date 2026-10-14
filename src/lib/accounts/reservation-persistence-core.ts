/** Dependency-injected transaction core. Production callers must use the server-only adapter. */
import type {
  AccountProvisioningOperation,
  EmailReservationKey,
  ProvisioningCommand,
  ProvisioningRequestIdentity,
} from "./account-provisioning-domain";
import type { DocumentReference, DocumentData, Firestore, Transaction } from "firebase-admin/firestore";
import type { ReservationKeyConfig, ReservationKeyVersion } from "./reservation-key";
const RESERVATIONS_COLLECTION = "provisioning_reservations";
const SUPPORTED_VERSIONS: ReservationKeyVersion[] = ["v1", "v2", "v3"];

type ReservationDocumentReference = DocumentReference;
type ReservationTransaction = Pick<Transaction, "get" | "create" | "set">;

export type ReservationFirestore = Pick<Firestore, "doc" | "runTransaction">;

export interface ReservationKeyFunctions {
  computeEmailReservationKey(
    email: string,
    config: ReservationKeyConfig,
  ): EmailReservationKey;
  validateReservationKey(key: string): {
    version: ReservationKeyVersion;
    opaqueKey: string;
  } | null;
}

export interface ProvisioningDomainFunctions {
  assertProvisioningOperation(value: unknown): asserts value is AccountProvisioningOperation;
  createProvisioningOperation(
    identity: ProvisioningRequestIdentity,
    now: string,
  ): AccountProvisioningOperation;
  assertSameProvisioningIdentity(
    operation: AccountProvisioningOperation,
    retry: ProvisioningRequestIdentity,
  ): void;
  acquireProvisioningLease: typeof import("./account-provisioning-domain").acquireProvisioningLease;
  renewProvisioningLease: typeof import("./account-provisioning-domain").renewProvisioningLease;
  applyProvisioningCommand: typeof import("./account-provisioning-domain").applyProvisioningCommand;
}

export class ReservationPersistenceError extends Error {
  readonly code: "persistence_unavailable" | "reservation_conflict" | "operation_not_found" | "operation_corrupt" | "recovery_forbidden";

  constructor(code: "persistence_unavailable" | "reservation_conflict" | "operation_not_found" | "operation_corrupt" | "recovery_forbidden") {
    super(code);
    this.code = code;
    this.name = "ReservationPersistenceError";
  }
}

export interface ReservationPersistenceDependencies {
  firestore: ReservationFirestore;
  domain: ProvisioningDomainFunctions;
  keys: ReservationKeyFunctions;
  now?: () => Date;
  authorizeRecoveryAdministrator?: (uid: string) => Promise<boolean>;
}

interface ReservationCandidate {
  key: EmailReservationKey;
  version: ReservationKeyVersion;
  reference: ReservationDocumentReference;
}

interface StoredReservation {
  operation: AccountProvisioningOperation;
  key: EmailReservationKey;
  reference: ReservationDocumentReference;
}

export interface ReservationResult {
  operation: AccountProvisioningOperation;
  newlyCreated: boolean;
  existingKey: EmailReservationKey;
}

export function createReservationPersistence(
  dependencies: ReservationPersistenceDependencies,
) {
  const { firestore, keys } = dependencies;
  const domain: ProvisioningDomainFunctions = dependencies.domain;
  const now = dependencies.now ?? (() => new Date());

  function getCandidates(
    email: string,
    config: ReservationKeyConfig,
  ): ReservationCandidate[] {
    const normalizedEmail = normalizeEmail(email);
    const activeKey = keys.computeEmailReservationKey(normalizedEmail, config);
    const active = keys.validateReservationKey(activeKey);
    if (!active || !SUPPORTED_VERSIONS.includes(active.version)) {
      throw new ReservationPersistenceError("persistence_unavailable");
    }

    const versions = SUPPORTED_VERSIONS.slice(0, SUPPORTED_VERSIONS.indexOf(active.version) + 1)
      .reverse();
    return versions.map((version) => {
      const key = version === active.version
        ? activeKey
        : keys.computeEmailReservationKey(normalizedEmail, {
            secret: config.secret,
            version,
          });
      return {
        key,
        version,
        reference: firestore.doc(`${RESERVATIONS_COLLECTION}/${key}`),
      };
    });
  }

  async function readExistingReservation(
    transaction: ReservationTransaction,
    candidates: ReservationCandidate[],
  ): Promise<StoredReservation | null> {
    const snapshots = await Promise.all(
      candidates.map(({ reference }) => transaction.get(reference)),
    );
    const existing = snapshots.flatMap((snapshot, index) =>
      snapshot.exists ? [{ snapshot, candidate: candidates[index] }] : [],
    );

    if (existing.length > 1) {
      throw new ReservationPersistenceError("reservation_conflict");
    }
    if (existing.length === 0) return null;

    const { snapshot, candidate } = existing[0];
    const operation = snapshot.data() as AccountProvisioningOperation | undefined;
    try {
      domain.assertProvisioningOperation(operation);
    } catch {
      throw new ReservationPersistenceError("operation_corrupt");
    }
    if (operation.emailReservationKey !== candidate.key) {
      throw new ReservationPersistenceError("operation_corrupt");
    }
    return {
      operation,
      key: candidate.key,
      reference: candidate.reference,
    };
  }

  function assertMatchingOperation(
    stored: StoredReservation,
    supplied: AccountProvisioningOperation,
  ): void {
    if (
      stored.operation.operationId !== supplied.operationId ||
      stored.operation.emailReservationKey !== supplied.emailReservationKey ||
      stored.operation.targetAuthUid !== supplied.targetAuthUid
    ) throw new ReservationPersistenceError("reservation_conflict");
  }

  async function readOperationByKey(
    transaction: ReservationTransaction,
    operation: AccountProvisioningOperation,
  ): Promise<StoredReservation> {
    const reference = firestore.doc(
      `${RESERVATIONS_COLLECTION}/${operation.emailReservationKey}`,
    );
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists) {
      throw new ReservationPersistenceError("operation_not_found");
    }

    const storedOperation = snapshot.data() as AccountProvisioningOperation | undefined;
    try {
      domain.assertProvisioningOperation(storedOperation);
    } catch {
      throw new ReservationPersistenceError("operation_corrupt");
    }
    if (storedOperation.emailReservationKey !== operation.emailReservationKey) {
      throw new ReservationPersistenceError("operation_corrupt");
    }
    return {
      operation: storedOperation,
      key: storedOperation.emailReservationKey,
      reference,
    };
  }

  async function authorizeRecoveryAdministrator(uid: string): Promise<void> {
    const authorize = dependencies.authorizeRecoveryAdministrator;
    if (!authorize || !(await authorize(uid))) {
      throw new ReservationPersistenceError("recovery_forbidden");
    }
  }

  async function reserveAccountOperation(
    email: string,
    targetAuthUid: string,
    initiatingAdminUid: string,
    requestedRole: ProvisioningRequestIdentity["requestedRole"],
    displayName: string,
    requestFingerprint: string,
    config: ReservationKeyConfig,
  ): Promise<ReservationResult> {
    const candidates = getCandidates(email, config);
    const activeCandidate = candidates[0];
    const createdAt = now().toISOString();
    const newOperation = domain.createProvisioningOperation({
      operationId: `reservation-${activeCandidate.key}`,
      targetAuthUid,
      initiatingAdminUid,
      requestedRole,
      displayName,
      emailReservationKey: activeCandidate.key,
      requestFingerprint,
    }, createdAt);

    return firestore.runTransaction(async (transaction) => {
      const existing = await readExistingReservation(transaction, candidates);
      if (existing) {
        try {
          domain.assertSameProvisioningIdentity(existing.operation, {
            operationId: existing.operation.operationId,
            targetAuthUid,
            initiatingAdminUid,
            requestedRole,
            displayName,
            emailReservationKey: existing.key,
            requestFingerprint,
          });
        } catch {
          throw new Error("identity_conflict");
        }

        return {
          operation: existing.operation,
          newlyCreated: false,
          existingKey: existing.key,
        };
      }

      transaction.create(
        activeCandidate.reference,
        newOperation as unknown as DocumentData,
      );
      return {
        operation: newOperation,
        newlyCreated: true,
        existingKey: activeCandidate.key,
      };
    });
  }

  async function acquirePersistedLease(
    operation: AccountProvisioningOperation,
    ownerId: string,
    expiresAt: string,
  ): Promise<AccountProvisioningOperation> {
    return firestore.runTransaction(async (transaction) => {
      const stored = await readOperationByKey(transaction, operation);
      assertMatchingOperation(stored, operation);
      const current = stored.operation;
      const at = now().toISOString();

      if (current.lease) {
        if (
          current.lease.ownerId === ownerId &&
          current.lease.expiresAt === expiresAt &&
          Date.parse(current.lease.expiresAt) > Date.parse(at) &&
          current.revision === operation.revision + 1
        ) return current;
        if (Date.parse(current.lease.expiresAt) > Date.parse(at)) {
          throw new Error("lease_required");
        }
        throw new Error("lease_expired");
      }
      if (current.revision !== operation.revision) {
        throw new Error("stale_revision");
      }
      if (current.stage === "requires_review") {
        throw new Error("review_decision_required");
      }

      const acquired = domain.acquireProvisioningLease(current, {
        ownerId,
        now: at,
        expiresAt,
        expectedRevision: current.revision,
      });
      transaction.set(stored.reference, acquired as unknown as DocumentData);
      return acquired;
    });
  }

  async function renewPersistedLease(
    operation: AccountProvisioningOperation,
    ownerId: string,
    fencingToken: number,
    expiresAt: string,
  ): Promise<AccountProvisioningOperation> {
    return firestore.runTransaction(async (transaction) => {
      const stored = await readOperationByKey(transaction, operation);
      assertMatchingOperation(stored, operation);
      const current = stored.operation;
      const at = now().toISOString();

      if (
        current.lease?.ownerId === ownerId &&
        current.lease.fencingToken === fencingToken &&
        current.lease.expiresAt === expiresAt &&
        Date.parse(current.lease.expiresAt) > Date.parse(at) &&
        current.revision === operation.revision + 1
      ) return current;
      if (current.revision !== operation.revision) {
        throw new Error("stale_revision");
      }
      if (current.stage === "requires_review") {
        await authorizeRecoveryAdministrator(ownerId);
      }

      const renewed = domain.renewProvisioningLease(current, {
        ownerId,
        fencingToken,
        expectedRevision: current.revision,
        now: at,
        expiresAt,
      });
      transaction.set(stored.reference, renewed as unknown as DocumentData);
      return renewed;
    });
  }

  async function advancePersistedStage(
    operation: AccountProvisioningOperation,
    command: ProvisioningCommand,
  ): Promise<AccountProvisioningOperation> {
    return firestore.runTransaction(async (transaction) => {
      const stored = await readOperationByKey(transaction, operation);
      assertMatchingOperation(stored, operation);
      const current = stored.operation;
      const replay = current.lastCommand?.commandId === command.commandId;

      if (!replay) {
        if (current.revision !== command.expectedRevision) {
          throw new Error("stale_revision");
        }
        const currentTime = now().toISOString();
        if (
          !current.lease ||
          Date.parse(current.lease.expiresAt) <= Date.parse(currentTime)
        ) throw new Error("lease_expired");
        if (Date.parse(command.at) > Date.parse(currentTime)) {
          throw new Error("invalid_operation");
        }
        if (command.type === "resolve_review") {
          if (command.decision.actorUid !== command.ownerId) {
            throw new ReservationPersistenceError("recovery_forbidden");
          }
          await authorizeRecoveryAdministrator(command.decision.actorUid);
        }
      }

      const updated = domain.applyProvisioningCommand(current, command);
      if (updated.revision !== current.revision) {
        transaction.set(stored.reference, updated as unknown as DocumentData);
      }
      return updated;
    });
  }

  async function recoverExpiredLease(
    operation: AccountProvisioningOperation,
    newOwnerId: string,
    newExpiresAt: string,
    authorizeAsUid: string,
  ): Promise<AccountProvisioningOperation> {
    if (authorizeAsUid !== newOwnerId) {
      throw new ReservationPersistenceError("recovery_forbidden");
    }

    return firestore.runTransaction(async (transaction) => {
      const stored = await readOperationByKey(transaction, operation);
      assertMatchingOperation(stored, operation);
      const current = stored.operation;
      const at = now().toISOString();
      await authorizeRecoveryAdministrator(authorizeAsUid);

      if (
        current.lease?.ownerId === newOwnerId &&
        current.lease.expiresAt === newExpiresAt &&
        Date.parse(current.lease.expiresAt) > Date.parse(at) &&
        current.revision === operation.revision + 1
      ) return current;
      if (current.revision !== operation.revision) {
        throw new Error("stale_revision");
      }

      const isReview = current.stage === "requires_review";
      const hasExpiredLease = current.lease !== null &&
        Date.parse(current.lease.expiresAt) <= Date.parse(at);
      if (current.lease && !hasExpiredLease) {
        throw new Error("lease_required");
      }
      if (!isReview && !hasExpiredLease) {
        throw new Error("lease_expired");
      }

      const recovered = domain.acquireProvisioningLease(current, {
        ownerId: newOwnerId,
        now: at,
        expiresAt: newExpiresAt,
        expectedRevision: current.revision,
      });
      transaction.set(stored.reference, recovered as unknown as DocumentData);
      return recovered;
    });
  }

  return {
    reserveAccountOperation,
    acquirePersistedLease,
    renewPersistedLease,
    advancePersistedStage,
    recoverExpiredLease,
  };
}

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (
    normalized.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
  ) throw new Error("invalid_email");
  return normalized;
}



