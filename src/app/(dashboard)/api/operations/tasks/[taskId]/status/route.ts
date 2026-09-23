import "server-only";

import {
  POST as lifecyclePOST,
} from "../lifecycle/route";

export const runtime = "nodejs";

/**
 * Compatibility endpoint.
 *
 * Delegate task status operations to
 * the authoritative lifecycle API.
 *
 * Preserve existing authorization,
 * transactional safeguards, and
 * operational audit logging.
 */
export const POST = lifecyclePOST;