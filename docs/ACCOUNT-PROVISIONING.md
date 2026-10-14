# Account provisioning lifecycle note

The current domain stage graph is `reserved → auth_create_pending → claims_pending → auth_enable_pending → finalize_pending → completed` (`src/lib/accounts/account-provisioning-domain.ts`). This ordering makes `auth_enable_pending` occur before the durable Firestore user-profile and `USER_CREATED` audit finalization. That conflicts with the security requirement that a newly provisioned Firebase Auth account remain disabled until both Firestore records are durably finalized.

UI-04C4A therefore implements only disabled-user creation/reconciliation, claims, and state verification. It deliberately does not expose an Auth enable operation, and the future coordinator must not advance or enable through this adapter before finalization.

Before API/coordinator integration, make the smallest safe lifecycle adjustment in a separately reviewed change: order finalization before the enabling step (`… claims_pending → finalize_pending → auth_enable_pending → completed`), and define the evidence for each transition so profile-plus-audit commit is confirmed before the Auth enable call. Keep the account disabled if either finalization or enable confirmation is uncertain. Do not edit the domain graph silently as part of the Auth adapter.

When Auth creation acknowledgement is lost but the reserved UID and normalized email are found, the adapter reports the identity recovered with `passwordState: "unknown"` and `requiresReview: true`. Keep that account disabled. Recovery requires an explicitly approved password-recovery path before any later activation; this adapter never resets an existing password.

Role-claim updates preserve all existing custom claims and only set the reserved role when no conflicting role claim exists. Firebase Auth offers no compare-and-swap for custom claims, so another concurrent claim writer remains a coordination risk; an unexpected post-write claim set is reported for review rather than silently accepted.