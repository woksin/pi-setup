import { UsageError, type Lane } from "../config.ts";
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
function roleAssignment(value: string): [string, Role] {
  const [id, role, extra] = value.split("=");
  if (!validId(id) || extra !== undefined) throw new UsageError("invalid --role; expected ID=role");
  if (!["lane", "repo-orch", "sub-orch"].includes(role)) throw new UsageError("invalid --role; expected lane, repo-orch or sub-orch");
  return [id, role as Role];
}
