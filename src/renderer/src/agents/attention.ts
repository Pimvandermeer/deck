export function project(cwd?: string | null): string {
  return cwd?.split("/").filter(Boolean).pop() ?? "~";
}
