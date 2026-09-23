
export function getTaskAssignmentId(
  taskId: string,
  technicianUid: string
): string {
  if (
    !taskId ||
    !technicianUid ||
    taskId.includes("/") ||
    technicianUid.includes("/") ||
    taskId.length > 512 ||
    technicianUid.length > 128
  ) {
    throw new Error(
      "Invalid task or technician identifier."
    );
  }

  return `${taskId}_${technicianUid}`;
}