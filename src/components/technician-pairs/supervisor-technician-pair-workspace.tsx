"use client";

import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import type {
  TechnicianPair,
} from "@/types/technician-pair";

import {
  TECHNICIAN_PAIR_STATUSES,
} from "@/types/technician-pair";

import {
  createTechnicianPair,
  deactivateTechnicianPair,
  getTechnicianPairs,
  TechnicianPairApiError,
} from "@/lib/technician-pairs/technician-pair-api";

import {
  getEligibleTechnicians,
} from "@/lib/tasks/task-api";

interface TechnicianIdentity {
  uid: string;
  fullName: string;
}

function formatTimestamp(
  value: string
): string {
  const date =
    new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

function statusLabel(
  pair: TechnicianPair
): string {
  return pair.status ===
    TECHNICIAN_PAIR_STATUSES.ACTIVE
    ? "Active"
    : "Inactive";
}

export function SupervisorTechnicianPairWorkspace() {
  const [
    pairs,
    setPairs,
  ] = useState<TechnicianPair[]>([]);

  const [
    technicians,
    setTechnicians,
  ] = useState<TechnicianIdentity[]>([]);

  const [
    loading,
    setLoading,
  ] = useState(true);

  const [
    refreshing,
    setRefreshing,
  ] = useState(false);

  const [
    error,
    setError,
  ] = useState<string | null>(null);

  const [
    firstTechnicianUid,
    setFirstTechnicianUid,
  ] = useState("");

  const [
    secondTechnicianUid,
    setSecondTechnicianUid,
  ] = useState("");

  const [
    creating,
    setCreating,
  ] = useState(false);

  const [
    creationError,
    setCreationError,
  ] = useState<string | null>(null);

  const [
    creationMessage,
    setCreationMessage,
  ] = useState<string | null>(null);

  const [
    deactivatingPairId,
    setDeactivatingPairId,
  ] = useState<string | null>(null);

  const [
    deactivationError,
    setDeactivationError,
  ] = useState<string | null>(null);

  const [
    deactivationMessage,
    setDeactivationMessage,
  ] = useState<string | null>(null);

  const loadWorkspace =
    useCallback(
      async (
        refresh = false
      ) => {
        if (refresh) {
          setRefreshing(true);
        } else {
          setLoading(true);
        }

        setError(null);

        try {
          const [
            pairResult,
            technicianResult,
          ] =
            await Promise.all([
              getTechnicianPairs(),
              getEligibleTechnicians(),
            ]);

          setPairs(
            pairResult.pairs
          );

          setTechnicians(
            technicianResult.technicians
          );

          setFirstTechnicianUid(
            (current) =>
              technicianResult.technicians.some(
                (technician) =>
                  technician.uid === current
              )
                ? current
                : ""
          );

          setSecondTechnicianUid(
            (current) =>
              technicianResult.technicians.some(
                (technician) =>
                  technician.uid === current
              )
                ? current
                : ""
          );
        } catch (loadError) {
          if (
            loadError instanceof
            TechnicianPairApiError
          ) {
            setError(
              loadError.message
            );
          } else if (
            loadError instanceof Error
          ) {
            setError(
              loadError.message
            );
          } else {
            setError(
              "Unable to load technician pairs."
            );
          }
        } finally {
          setLoading(false);
          setRefreshing(false);
        }
      },
      []
    );

  useEffect(() => {
    void loadWorkspace();
  }, [loadWorkspace]);

  const technicianNames =
    useMemo(
      () =>
        new Map(
          technicians.map(
            (technician) => [
              technician.uid,
              technician.fullName,
            ]
          )
        ),
      [technicians]
    );

  const availableFirstTechnicians =
    useMemo(
      () =>
        technicians.filter(
          (technician) =>
            technician.uid !==
            secondTechnicianUid
        ),
      [
        technicians,
        secondTechnicianUid,
      ]
    );

  const availableSecondTechnicians =
    useMemo(
      () =>
        technicians.filter(
          (technician) =>
            technician.uid !==
            firstTechnicianUid
        ),
      [
        technicians,
        firstTechnicianUid,
      ]
    );

  const hasTwoEligibleTechnicians =
    technicians.length >= 2;

  const selectionIsValid =
    firstTechnicianUid.length > 0 &&
    secondTechnicianUid.length > 0 &&
    firstTechnicianUid !==
      secondTechnicianUid;

  const creationDisabled =
    creating ||
    refreshing ||
    deactivatingPairId !== null ||
    !hasTwoEligibleTechnicians ||
    !selectionIsValid;

  function technicianLabel(
    uid: string
  ): string {
    return (
      technicianNames.get(uid) ??
      `Technician ${uid}`
    );
  }

  async function handleCreatePair(
    event: FormEvent<HTMLFormElement>
  ) {
    event.preventDefault();

    setCreationError(null);
    setCreationMessage(null);
    setDeactivationError(null);
    setDeactivationMessage(null);

    if (!selectionIsValid) {
      setCreationError(
        "Choose two different eligible technicians."
      );
      return;
    }

    setCreating(true);

    try {
      const result =
        await createTechnicianPair({
          technicianIds: [
            firstTechnicianUid,
            secondTechnicianUid,
          ],
        });

      setFirstTechnicianUid("");
      setSecondTechnicianUid("");

      await loadWorkspace(true);

      setCreationMessage(
        result.message
      );
    } catch (createError) {
      if (
        createError instanceof
        TechnicianPairApiError
      ) {
        setCreationError(
          createError.message
        );
      } else if (
        createError instanceof Error
      ) {
        setCreationError(
          createError.message
        );
      } else {
        setCreationError(
          "Unable to create the technician pair."
        );
      }
    } finally {
      setCreating(false);
    }
  }

  async function handleDeactivatePair(
    pair: TechnicianPair
  ) {
    if (
      pair.status !==
      TECHNICIAN_PAIR_STATUSES.ACTIVE
    ) {
      setDeactivationMessage(null);
      setDeactivationError(
        "Only an active technician pair can be deactivated."
      );
      return;
    }

    const confirmed =
      window.confirm(
        `Deactivate permanent pair ${pair.id}? This releases both pair reservations. It does not block either technician, delete the historical pair record, or mark shift attendance.`
      );

    if (!confirmed) {
      return;
    }

    setCreationError(null);
    setCreationMessage(null);
    setDeactivationError(null);
    setDeactivationMessage(null);
    setDeactivatingPairId(
      pair.id
    );

    try {
      const result =
        await deactivateTechnicianPair(
          pair.id
        );

      if (result.success !== true) {
        throw new Error(
          result.error
        );
      }

      await loadWorkspace(true);

      setDeactivationMessage(
        result.message
      );
    } catch (deactivateError) {
      if (
        deactivateError instanceof
        TechnicianPairApiError
      ) {
        setDeactivationError(
          deactivateError.message
        );
      } else if (
        deactivateError instanceof Error
      ) {
        setDeactivationError(
          deactivateError.message
        );
      } else {
        setDeactivationError(
          "Unable to deactivate the technician pair."
        );
      }
    } finally {
      setDeactivatingPairId(null);
    }
  }

  if (loading) {
    return (
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-sm text-slate-600">
          Loading technician pairs...
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div>
          <h2 className="text-lg font-semibold text-slate-950">
            Permanent Technician Pairs
          </h2>

          <p className="mt-1 text-sm text-slate-600">
            {pairs.length} pair
            {pairs.length === 1
              ? ""
              : "s"}{" "}
            recorded.
          </p>
        </div>

        <button
          type="button"
          onClick={() => {
            setCreationError(null);
            setCreationMessage(null);
            setDeactivationError(null);
            setDeactivationMessage(null);
            void loadWorkspace(true);
          }}
          disabled={
            refreshing ||
            creating ||
            deactivatingPairId !== null
          }
          className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {refreshing
            ? "Refreshing..."
            : "Refresh"}
        </button>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div>
          <h3 className="font-semibold text-slate-950">
            Create Permanent Pair
          </h3>

          <p className="mt-1 text-sm text-slate-600">
            Select two eligible technicians. Pair membership
            records their permanent working relationship; it
            does not mark either technician present or create
            shift attendance.
          </p>
        </div>

        {!hasTwoEligibleTechnicians ? (
          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            At least two eligible technicians are required to
            create a permanent pair.
          </div>
        ) : (
          <form
            className="mt-5 space-y-4"
            onSubmit={handleCreatePair}
          >
            <div className="grid gap-4 md:grid-cols-2">
              <label className="block">
                <span className="text-sm font-medium text-slate-700">
                  Technician A
                </span>

                <select
                  value={firstTechnicianUid}
                  onChange={(event) => {
                    setFirstTechnicianUid(
                      event.target.value
                    );
                    setCreationError(null);
                    setCreationMessage(null);
                  }}
                  disabled={
                    creating ||
                    refreshing ||
                    deactivatingPairId !== null
                  }
                  className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-slate-500 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500"
                >
                  <option value="">
                    Select technician A
                  </option>

                  {availableFirstTechnicians.map(
                    (technician) => (
                      <option
                        key={technician.uid}
                        value={technician.uid}
                      >
                        {technician.fullName}
                      </option>
                    )
                  )}
                </select>
              </label>

              <label className="block">
                <span className="text-sm font-medium text-slate-700">
                  Technician B
                </span>

                <select
                  value={secondTechnicianUid}
                  onChange={(event) => {
                    setSecondTechnicianUid(
                      event.target.value
                    );
                    setCreationError(null);
                    setCreationMessage(null);
                  }}
                  disabled={
                    creating ||
                    refreshing ||
                    deactivatingPairId !== null
                  }
                  className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-slate-500 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500"
                >
                  <option value="">
                    Select technician B
                  </option>

                  {availableSecondTechnicians.map(
                    (technician) => (
                      <option
                        key={technician.uid}
                        value={technician.uid}
                      >
                        {technician.fullName}
                      </option>
                    )
                  )}
                </select>
              </label>
            </div>

            {creationError ? (
              <div
                role="alert"
                className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"
              >
                {creationError}
              </div>
            ) : null}

            {creationMessage ? (
              <div
                role="status"
                className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800"
              >
                {creationMessage}
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="submit"
                disabled={creationDisabled}
                className="rounded-lg bg-slate-950 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {creating
                  ? "Creating pair..."
                  : "Create pair"}
              </button>

              <p className="text-xs text-slate-500">
                The server revalidates both technicians before
                reserving the permanent pair.
              </p>
            </div>
          </form>
        )}
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"
        >
          {error}
        </div>
      ) : null}

      {deactivationError ? (
        <div
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"
        >
          {deactivationError}
        </div>
      ) : null}

      {deactivationMessage ? (
        <div
          role="status"
          className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800"
        >
          {deactivationMessage}
        </div>
      ) : null}

      {!error &&
      pairs.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center">
          <h3 className="font-medium text-slate-900">
            No technician pairs yet
          </h3>

          <p className="mt-2 text-sm text-slate-600">
            Permanent technician pairs will appear
            here after they are configured.
          </p>
        </div>
      ) : null}

      {!error &&
      pairs.length > 0 ? (
        <div className="grid gap-4">
          {pairs.map((pair) => (
            <article
              key={pair.id}
              className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="font-semibold text-slate-950">
                    {technicianLabel(
                      pair.technicianIds[0]
                    )}
                    {" + "}
                    {technicianLabel(
                      pair.technicianIds[1]
                    )}
                  </h3>

                  <p className="mt-1 text-xs text-slate-500">
                    Pair ID: {pair.id}
                  </p>
                </div>

                <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-700">
                  {statusLabel(pair)}
                </span>
              </div>

              <div className="mt-5 grid gap-4 sm:grid-cols-2">
                <div className="rounded-lg bg-slate-50 p-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                    Technician A
                  </p>

                  <p className="mt-1 font-medium text-slate-900">
                    {technicianLabel(
                      pair.technicianIds[0]
                    )}
                  </p>

                  <p className="mt-1 break-all text-xs text-slate-500">
                    {pair.technicianIds[0]}
                  </p>
                </div>

                <div className="rounded-lg bg-slate-50 p-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                    Technician B
                  </p>

                  <p className="mt-1 font-medium text-slate-900">
                    {technicianLabel(
                      pair.technicianIds[1]
                    )}
                  </p>

                  <p className="mt-1 break-all text-xs text-slate-500">
                    {pair.technicianIds[1]}
                  </p>
                </div>
              </div>

              <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-slate-500">
                    Created
                  </dt>
                  <dd className="mt-1 text-slate-900">
                    {formatTimestamp(
                      pair.createdAt
                    )}
                  </dd>
                </div>

                <div>
                  <dt className="text-slate-500">
                    Updated
                  </dt>
                  <dd className="mt-1 text-slate-900">
                    {formatTimestamp(
                      pair.updatedAt
                    )}
                  </dd>
                </div>

                {pair.deactivatedAt ? (
                  <div>
                    <dt className="text-slate-500">
                      Deactivated
                    </dt>
                    <dd className="mt-1 text-slate-900">
                      {formatTimestamp(
                        pair.deactivatedAt
                      )}
                    </dd>
                  </div>
                ) : null}

                {pair.deactivatedBy ? (
                  <div>
                    <dt className="text-slate-500">
                      Deactivated by
                    </dt>
                    <dd className="mt-1 break-all text-slate-900">
                      {pair.deactivatedBy}
                    </dd>
                  </div>
                ) : null}
              </dl>

              {pair.status ===
              TECHNICIAN_PAIR_STATUSES.ACTIVE ? (
                <div className="mt-5 border-t border-slate-200 pt-4">
                  <p className="text-xs leading-5 text-slate-500">
                    Deactivation preserves this historical pair
                    record and does not mark either technician
                    absent, present, blocked, or revoked.
                  </p>

                  <button
                    type="button"
                    onClick={() => {
                      void handleDeactivatePair(
                        pair
                      );
                    }}
                    disabled={
                      refreshing ||
                      creating ||
                      deactivatingPairId !== null
                    }
                    className="mt-3 rounded-lg border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {deactivatingPairId ===
                    pair.id
                      ? "Deactivating pair..."
                      : "Deactivate pair"}
                  </button>
                </div>
              ) : null}
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}