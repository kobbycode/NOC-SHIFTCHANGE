"use client";

import {
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

  function technicianLabel(
    uid: string
  ): string {
    return (
      technicianNames.get(uid) ??
      `Technician ${uid}`
    );
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
            void loadWorkspace(true);
          }}
          disabled={refreshing}
          className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {refreshing
            ? "Refreshing..."
            : "Refresh"}
        </button>
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"
        >
          {error}
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
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}