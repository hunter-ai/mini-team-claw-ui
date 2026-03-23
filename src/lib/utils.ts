export function formatRelativeDate(value: Date | string | null | undefined) {
  if (!value) {
    return "No activity yet";
  }

  const date = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
