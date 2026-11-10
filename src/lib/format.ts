const accraDateTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Accra",
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const accraDate = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Accra",
  day: "2-digit",
  month: "short",
  year: "numeric",
});

function parse(value: string | null | undefined): number | null {
  if (!value) return null;

  const milliseconds = Date.parse(value);

  return Number.isFinite(milliseconds) ? milliseconds : null;
}

export function formatDateTime(value: string | null | undefined): string {
  const milliseconds = parse(value);

  return milliseconds === null ? "—" : accraDateTime.format(new Date(milliseconds));
}

export function formatDate(value: string | null | undefined): string {
  const milliseconds = parse(value);

  return milliseconds === null ? "—" : accraDate.format(new Date(milliseconds));
}

export function humanize(value: string | null | undefined): string {
  if (!value) return "—";

  const text = value.replaceAll("_", " ").trim();

  return text ? text[0]!.toUpperCase() + text.slice(1) : "—";
}
