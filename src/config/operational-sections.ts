export const OPERATIONAL_SECTIONS = [
  {
    key: "broadcast",
    label: "Broadcast checks",
    href: "/technician/operations?section=broadcast",
  },
  {
    key: "faults",
    label: "Faults and activities",
    href: "/technician/operations?section=faults",
  },
  {
    key: "outside-broadcasts",
    label: "Outside broadcasts",
    href: "/technician/operations?section=outside-broadcasts",
  },
  {
    key: "tasks",
    label: "My tasks",
    href: "/technician/operations?section=tasks",
  },
  {
    key: "report",
    label: "Shift report preview",
    href: "/technician/operations?section=report",
  },
] as const;

export type OperationalSection = (typeof OPERATIONAL_SECTIONS)[number]["key"];

export const DEFAULT_OPERATIONAL_SECTION: OperationalSection = "broadcast";

export function isOperationalSection(
  value: unknown,
): value is OperationalSection {
  return OPERATIONAL_SECTIONS.some((section) => section.key === value);
}

export function resolveOperationalSection(
  value: string | string[] | undefined,
): OperationalSection {
  if (typeof value !== "string") return DEFAULT_OPERATIONAL_SECTION;
  return isOperationalSection(value)
    ? value
    : DEFAULT_OPERATIONAL_SECTION;
}
