interface PageLoadingProps {
  label: string;
}

const TILE_KEYS = ["tile-1", "tile-2", "tile-3", "tile-4"];

const ROW_KEYS = ["row-1", "row-2", "row-3", "row-4"];

export function PageLoading({ label }: PageLoadingProps) {
  return (
    <div className="space-y-6" role="status" aria-live="polite">
      <span className="sr-only">{label}</span>

      <div
        aria-hidden="true"
        className="page-loading-track h-1 rounded-full bg-[var(--elevated)]"
      />

      <div
        aria-hidden="true"
        className="space-y-6 motion-safe:animate-pulse"
      >
        <header className="space-y-3">
          <div className="h-7 w-48 rounded-lg bg-[var(--elevated)]" />

          <div className="h-4 w-80 max-w-full rounded bg-[var(--elevated)]" />
        </header>

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {TILE_KEYS.map((key) => (
            <div
              key={key}
              className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5"
            >
              <div className="h-3 w-24 rounded bg-[var(--elevated)]" />

              <div className="mt-4 h-7 w-16 rounded-md bg-[var(--elevated)]" />
            </div>
          ))}
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          {["panel-1", "panel-2"].map((key) => (
            <section
              key={key}
              className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5"
            >
              <div className="h-5 w-40 rounded bg-[var(--elevated)]" />

              <div className="mt-5 space-y-3">
                {ROW_KEYS.map((row) => (
                  <div
                    key={row}
                    className="h-4 rounded bg-[var(--elevated)]"
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
