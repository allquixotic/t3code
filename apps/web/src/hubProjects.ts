import { CommandId, EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";
import { randomUUID } from "./lib/utils";
import { resolvePrimaryEnvironmentHttpUrl } from "./environments/primary";

const HubProject = Schema.Struct({
  id: ProjectId,
  commandId: CommandId,
  hubOrigin: Schema.String,
  alias: Schema.String,
  title: Schema.String,
  workspaceRoot: Schema.String,
  createdAt: Schema.String,
  environmentId: Schema.optional(EnvironmentId),
  phase: Schema.Literals(["waiting", "creating", "ready", "error"]),
  error: Schema.optional(Schema.String),
});
export type HubProject = typeof HubProject.Type;
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(HubProject)));
const storageKey = "t3.hub.projects.v1";
export const useHubProjects = create<{ projects: ReadonlyArray<HubProject> }>(() => ({
  projects: [],
}));

export function loadHubProjects() {
  try {
    const origin = new URL(resolvePrimaryEnvironmentHttpUrl("/")).origin;
    const projects = decode(localStorage.getItem(storageKey) ?? "[]")
      .filter((project) => project.hubOrigin === origin)
      .map((project) =>
        project.phase === "creating" ? { ...project, phase: "waiting" as const } : project,
      );
    useHubProjects.setState({ projects });
  } catch {
    /* Unavailable storage does not prevent creating a project in this session. */
  }
}
function save(projects: ReadonlyArray<HubProject>) {
  useHubProjects.setState({ projects });
  try {
    localStorage.setItem(storageKey, JSON.stringify(projects));
  } catch {
    /* Session state remains available. */
  }
}
export function createHubProject(alias: string, workspaceRoot: string): HubProject {
  const path = workspaceRoot.trim();
  if (!/^(?:~(?:[\\/]|$)|\/|[A-Za-z]:[\\/]|\\\\)/.test(path) || /[\0\r\n]/.test(path))
    throw new Error("Enter an absolute remote folder path or a path starting with ~/.");
  const origin = new URL(resolvePrimaryEnvironmentHttpUrl("/")).origin;
  const existing = useHubProjects
    .getState()
    .projects.find((p) => p.hubOrigin === origin && p.alias === alias && p.workspaceRoot === path);
  if (existing) return existing;
  const project: HubProject = {
    id: ProjectId.make(randomUUID()),
    commandId: CommandId.make(randomUUID()),
    hubOrigin: origin,
    alias,
    title:
      path
        .replace(/[\\/]+$/, "")
        .split(/[\\/]/)
        .at(-1) || alias,
    workspaceRoot: path,
    createdAt: new Date().toISOString(),
    phase: "waiting",
  };
  save([...useHubProjects.getState().projects, project]);
  return project;
}
export function updateHubProject(
  id: string,
  change: Partial<Pick<HubProject, "phase" | "error" | "environmentId">>,
) {
  save(
    useHubProjects
      .getState()
      .projects.map((project) => (project.id === id ? { ...project, ...change } : project)),
  );
}
export function removeHubProject(id: string) {
  save(useHubProjects.getState().projects.filter((project) => project.id !== id));
}
