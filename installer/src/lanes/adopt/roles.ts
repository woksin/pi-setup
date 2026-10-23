import { UsageError, validRepo, type Lane } from "../config.ts";
import { validId } from "../names.ts";

export type Role = NonNullable<Lane["role"]>;
export function requestedRoles(value: string | undefined, coordinatorId: string): Map<string, Role> {
  const roles = new Map<string, Role>();
  if (value === undefined) return roles;
  for (const assignment of value.split(",")) {
    const [id, role] = roleAssignment(assignment);
    if (id === coordinatorId) throw new UsageError("--role cannot target the coordinator");
    if (roles.has(id) && roles.get(id) !== role) throw new UsageError(`conflicting --role for ${id}`);
    roles.set(id, role);
  }
  return roles;
}
export function requestedOrchestrates(value: string | undefined, coordinatorId: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const assignment of value?.split(";") ?? []) {
    const [id, repos, extra] = assignment.split("=");
    if (!validId(id) || id === coordinatorId || !repos || extra !== undefined || !repos.split(",").every(validRepo)) {
      throw new UsageError("invalid --orchestrates; expected ID=owner/repo,owner/repo for a repo-orch");
    }
    result.set(id, [...new Set([...(result.get(id) ?? []), ...repos.split(",")])]);
  }
  return result;
}
function roleAssignment(value: string): [string, Role] {
  const [id, role, extra] = value.split("=");
  if (!validId(id) || extra !== undefined) throw new UsageError("invalid --role; expected ID=role");
  if (!["lane", "repo-orch", "sub-orch"].includes(role)) throw new UsageError("invalid --role; expected lane, repo-orch or sub-orch");
  return [id, role as Role];
}
