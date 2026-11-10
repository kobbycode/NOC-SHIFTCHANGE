interface AppLoadingScreenProps {
  label: string;
}

export function AppLoadingScreen({ label }: AppLoadingScreenProps) {
  return (
    <main
      className="flex min-h-screen flex-col items-center justify-center gap-6 bg-[var(--background)] px-6"
      role="status"
      aria-live="polite"
    >
      <span className="sr-only">{label}</span>

      <p
        aria-hidden="true"
        className="text-lg font-semibold tracking-tight text-[var(--foreground)]"
      >
        ShiftChange 2.0
      </p>

      <div
        aria-hidden="true"
        className="page-loading-track h-1 w-48 rounded-full bg-[var(--elevated)]"
      />
    </main>
  );
}
