import { HostError } from "./errors.js";
import type { DurableStore } from "./durable-store.js";
import type { PermissionProfile, ProjectRecord, ProjectTrust } from "./types.js";

const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/u;

export interface RegisterProjectInput {
  projectId: string;
  name: string;
  rootPath: string;
  trust: ProjectTrust;
  allowedPermissionProfiles: PermissionProfile[];
  defaultPermissionProfile: PermissionProfile;
  networkAccess: boolean;
  instructions: string[];
}

export class ProjectRegistry {
  constructor(private readonly store: DurableStore) {}

  async register(input: RegisterProjectInput): Promise<ProjectRecord> {
    if (!PROJECT_ID_PATTERN.test(input.projectId)) {
      throw new HostError(
        "project_id_invalid",
        "projectId must be 2-64 lowercase letters, digits, underscores, or hyphens",
      );
    }
    if (!input.allowedPermissionProfiles.includes(input.defaultPermissionProfile)) {
      throw new HostError(
        "project_permission_invalid",
        "defaultPermissionProfile must be included in allowedPermissionProfiles",
      );
    }
    if (input.trust === "archive" && input.defaultPermissionProfile !== "read-only") {
      throw new HostError("archive_must_be_read_only", "Archive projects must default to read-only");
    }

    const canonicalRoot = await this.store.canonicalDirectory(input.rootPath);
    const existing = await this.store.listProjects();
    const prior = existing.find((project) => project.projectId === input.projectId);
    if (prior !== undefined && !samePath(prior.rootPath, canonicalRoot)) {
      throw new HostError(
        "project_root_immutable",
        `Project ${input.projectId} is already bound to ${prior.rootPath}; register a new projectId for another root`,
      );
    }
    const name = input.name.trim();
    if (name.length === 0) throw new HostError("project_name_invalid", "Project name cannot be blank");
    const now = new Date().toISOString();
    const project: ProjectRecord = {
      schemaVersion: 1,
      projectId: input.projectId,
      name,
      rootPath: canonicalRoot,
      trust: input.trust,
      allowedPermissionProfiles: [...new Set(input.allowedPermissionProfiles)],
      defaultPermissionProfile: input.defaultPermissionProfile,
      networkAccess: input.networkAccess,
      instructions: input.instructions.map((instruction) => instruction.trim()).filter(Boolean),
      createdAt: prior?.createdAt ?? now,
      updatedAt: now,
    };
    return this.store.upsertProject(project);
  }

  async resolve(projectId: string, requestedPermission?: PermissionProfile): Promise<{
    project: ProjectRecord;
    permissionProfile: PermissionProfile;
  }> {
    const project = await this.store.getProject(projectId);
    const permissionProfile = requestedPermission ?? project.defaultPermissionProfile;
    if (!project.allowedPermissionProfiles.includes(permissionProfile)) {
      throw new HostError(
        "permission_profile_not_allowed",
        `Project ${projectId} does not allow ${permissionProfile}`,
      );
    }
    if (project.trust === "archive" && permissionProfile !== "read-only") {
      throw new HostError("archive_is_read_only", `Project ${projectId} is an archive`);
    }
    return { project, permissionProfile };
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0
    : left === right;
}
