import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useAtomCommand } from "../state/use-atom-command";
import { projectEnvironment } from "../state/projects";
import { useProjects } from "../state/entities";
import { useEnvironments } from "../state/environments";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import {
  connectHubEnvironment,
  hubAliasForEnvironment,
  hubEnvironmentStatusText,
  useHubEnvironments,
} from "../hubEnvironments";
import {
  createHubProject,
  loadHubProjects,
  removeHubProject,
  updateHubProject,
  useHubProjects,
} from "../hubProjects";
import { HubConnectionProgress } from "./HubConnectionProgress";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { SidebarInset } from "./ui/sidebar";

/** Finish saved project creations using the selected remote's native RPC, never the hub's filesystem. */
export function HubProjectCoordinator() {
  const drafts = useHubProjects((state) => state.projects);
  const projects = useProjects();
  const { environments } = useEnvironments();
  const { environments: managed } = useHubEnvironments();
  const create = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const inFlight = useRef(new Set<string>());
  useEffect(loadHubProjects, []);
  useEffect(() => {
    for (const draft of drafts) {
      if (draft.phase !== "waiting" || inFlight.current.has(draft.id)) continue;
      if (managed.find((row) => row.alias === draft.alias)?.phase !== "active") continue;
      const environment = environments.find((row) => hubAliasForEnvironment(row) === draft.alias);
      if (environment?.connection.phase !== "connected") continue;
      const existing = projects.find(
        (p) => p.environmentId === environment.environmentId && p.id === draft.id,
      );
      if (existing) {
        updateHubProject(draft.id, { phase: "ready", environmentId: environment.environmentId });
        continue;
      }
      inFlight.current.add(draft.id);
      updateHubProject(draft.id, { phase: "creating", environmentId: environment.environmentId });
      void create({
        environmentId: environment.environmentId,
        input: {
          projectId: draft.id,
          commandId: draft.commandId,
          title: draft.title,
          workspaceRoot: draft.workspaceRoot,
          createWorkspaceRootIfMissing: true,
          defaultModelSelection: null,
        },
      })
        .then((result) => {
          updateHubProject(
            draft.id,
            result._tag === "Success"
              ? { phase: "ready" }
              : {
                  phase: "error",
                  error:
                    "Could not create the remote folder or project. Check remote access and folder permissions, then retry.",
                },
          );
        })
        .catch(() => {
          updateHubProject(draft.id, {
            phase: "error",
            error: "Project creation was interrupted. Reconnect, then retry to check its outcome.",
          });
        })
        .finally(() => {
          inFlight.current.delete(draft.id);
        });
    }
  }, [create, drafts, environments, managed, projects]);
  return null;
}

export function HubProjectEntries() {
  const drafts = useHubProjects((state) => state.projects);
  const { environments } = useHubEnvironments();
  if (!drafts.length) return null;
  return (
    <div className="px-3 py-2 space-y-1" aria-label="Remote projects">
      {drafts.map((project) => {
        const environment = environments.find((row) => row.alias === project.alias);
        return (
          <Link
            key={project.id}
            to="/hub/projects/$projectId"
            params={{ projectId: project.id }}
            className="block rounded-md px-2 py-2 text-sm hover:bg-accent"
          >
            <span className="block truncate font-medium">{project.title}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {environment?.label ?? project.alias} ·{" "}
              {project.phase === "ready"
                ? "Open project"
                : environment
                  ? hubEnvironmentStatusText(environment)
                  : "Waiting to connect"}
            </span>
          </Link>
        );
      })}
    </div>
  );
}

export function HubProjectPage({ projectId, alias }: { projectId?: string; alias?: string }) {
  const { environments, error: hubError } = useHubEnvironments();
  const project = useHubProjects((state) => state.projects.find((row) => row.id === projectId));
  const environment = environments.find((row) => row.alias === (project?.alias ?? alias));
  const projects = useProjects();
  const navigate = useNavigate();
  const open = useNewThreadHandler();
  const [path, setPath] = useState("~/projects/");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const opening = useRef(false);
  useEffect(() => {
    if (
      !project?.environmentId ||
      project.phase !== "ready" ||
      opening.current ||
      environment?.phase !== "active"
    )
      return;
    if (!projects.some((p) => p.id === project.id && p.environmentId === project.environmentId))
      return;
    opening.current = true;
    void open(scopeProjectRef(project.environmentId, project.id), { replace: true })
      .then((result) => {
        if (result) removeHubProject(project.id);
        else {
          opening.current = false;
          setError("Project is ready. Use Open project to continue.");
        }
      })
      .catch(() => {
        opening.current = false;
        setError("Could not open the project. Try again.");
      });
  }, [environment?.phase, open, project, projects]);
  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!environment) return;
    setSaving(true);
    setError(null);
    try {
      const draft = createHubProject(environment.alias, path);
      await navigate({
        to: "/hub/projects/$projectId",
        params: { projectId: draft.id },
        replace: true,
      });
      // Project creation is the explicit user action authorizing a new approval request.
      await connectHubEnvironment(environment.alias);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not request access");
    } finally {
      setSaving(false);
    }
  };
  return (
    <SidebarInset className="h-svh min-h-0 overflow-auto bg-background text-foreground md:h-dvh">
      <section className="m-auto w-full max-w-2xl space-y-6 p-8">
        <div>
          <p className="text-sm text-muted-foreground">
            {environment?.label ?? project?.alias ?? alias}
          </p>
          <h1 className="text-2xl font-semibold">{project?.title ?? "New remote project"}</h1>
        </div>
        {!environment ? (
          <p role="status">{hubError ?? "Loading destination…"}</p>
        ) : !project ? (
          <form onSubmit={(event) => void create(event)} className="space-y-4">
            <label className="block space-y-2 text-sm">
              Folder on {environment.label}
              <Input
                value={path}
                onChange={(event) => setPath(event.target.value)}
                autoFocus
                placeholder="~/projects/my-project"
              />
            </label>
            <p className="text-sm text-muted-foreground">
              Create the project now. After your passkey approval, T3 will connect, install any
              required software, and open or create this folder on {environment.label}.
            </p>
            <Button type="submit" disabled={saving || !path.trim()}>
              {saving ? "Creating…" : "Create project"}
            </Button>
          </form>
        ) : (
          <>
            <p className="text-sm text-muted-foreground break-all">{project.workspaceRoot}</p>
            {project.phase === "creating" ? (
              <p role="status">Creating the project on {environment.label}…</p>
            ) : (
              <HubConnectionProgress environment={environment} />
            )}
            {project.phase === "error" && (
              <div className="space-y-3">
                <p role="alert" className="text-sm text-destructive">
                  {project.error}
                </p>
                <Button
                  variant="outline"
                  onClick={() => updateHubProject(project.id, { phase: "waiting" })}
                >
                  Retry project creation
                </Button>
              </div>
            )}
            {project.phase === "ready" && project.environmentId && (
              <Button
                onClick={() =>
                  void open(scopeProjectRef(project.environmentId!, project.id)).then((result) => {
                    if (result) removeHubProject(project.id);
                  })
                }
              >
                Open project
              </Button>
            )}
            <Button
              variant="ghost"
              onClick={() => {
                removeHubProject(project.id);
                void navigate({ to: "/" });
              }}
            >
              Remove project setup
            </Button>
          </>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </section>
    </SidebarInset>
  );
}
