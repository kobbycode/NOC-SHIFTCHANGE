"use client";
// Phase 3 — the last page of the A–E form is a SHARED console. The technician
// sitting at it picks which of the two reserved incoming identities is accepting
// now and proves that choice with THAT person's own password. The server issues
// the accepting technician's session cookie in the acceptance response, so the
// receipt is rendered here first and the console only moves on when the
// technician continues. Nothing here ever claims a login that was not issued.

export type ConsoleIncomingIdentity = { uid: string; label: string };

export type HandoverSessionOutcome = {
  issued: boolean;
  firstActivation: boolean;
  acceptingTechnicianUid: string;
  consoleActorUid: string;
  issuanceId: string;
  issuanceRecorded: boolean;
  replayed: boolean;
  outgoingSessionsRevoked: boolean;
  revokedOutgoingTechnicianUids: string[];
};

const field = "block w-full rounded-lg border bg-transparent p-2";

export function IncomingIdentityPicker({
  identities,
  value,
  onChange,
  disabled,
}: {
  identities: ConsoleIncomingIdentity[];
  value: string;
  onChange: (uid: string) => void;
  disabled: boolean;
}) {
  return <label className="text-sm">
    Who is accepting now?
    <select
      className={field}
      name="technicianUid"
      value={value}
      disabled={disabled}
      required
      onChange={(event) => onChange(event.currentTarget.value)}
    >
      <option value="">Select the incoming technician at this console</option>
      {identities.map((identity) => <option key={identity.uid} value={identity.uid}>{identity.label}</option>)}
    </select>
    <span className="text-neutral-600">Only the two reserved incoming technicians of this handover are offered. The password below must be that person&rsquo;s own; a colleague cannot accept for them.</span>
  </label>;
}

export function HandoverSessionNotice({ session, label }: { session: HandoverSessionOutcome; label: string }) {
  if (!session.issued) {
    // The acceptance is committed even though no cookie could be minted. The
    // outgoing sessions may already be revoked, so this console must not keep
    // reading as the previous technician.
    return <div role="alert" className="space-y-2 rounded-lg border border-amber-500 p-3 text-sm">
      <p className="font-semibold text-amber-800">Your acceptance is recorded, but this console could not sign you in.</p>
      <p>No session was issued for {label}. Your acceptance and attendance are already persisted and will not be duplicated. Sign in with your own password to continue.</p>
      <a href="/login" className="inline-block w-fit rounded-lg border p-2">Go to sign in</a>
    </div>;
  }
  return <div className="space-y-2 rounded-lg border border-green-600 p-3 text-sm">
    <p className="font-semibold text-green-800">You are now signed in as {label}.</p>
    {session.replayed && <p>Your earlier acceptance was replayed — no second application was created — and this console session was re-issued for you.</p>}
    {session.firstActivation
      ? session.outgoingSessionsRevoked
        ? <p>The outgoing technicians&rsquo; sessions were revoked, so this console no longer acts as them.</p>
        : <p role="alert" className="text-red-700">The outgoing technicians&rsquo; sessions could not be revoked. Report this to a supervisor before leaving the console.</p>
      : <p>The first incoming technician&rsquo;s session is unaffected; you joined the same active shift with your own attendance clock.</p>}
    <button
      type="button"
      className="w-fit rounded-lg bg-green-700 p-2 text-white"
      onClick={() => window.location.assign("/technician")}
    >Continue to my shift</button>
  </div>;
}