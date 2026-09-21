import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";

const state = vi.hoisted(() => ({
  native: [] as Array<{ environmentId: string; displayUrl: string; connection: { phase: string } }>,
  projects: [] as Array<{ id: string; environmentId: string }>,
  create: vi.fn(),
  request: vi.fn(),
  navigate: vi.fn(),
  open: vi.fn(),
}));
vi.mock("../environments/primary", () => ({
  resolvePrimaryEnvironmentHttpUrl: (path: string) => `https://hub.example${path}`,
}));
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({ environments: state.native }),
}));
vi.mock("../state/entities", () => ({ useProjects: () => state.projects }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => state.create }));
vi.mock("../state/projects", () => ({ projectEnvironment: { create: {} } }));
vi.mock("../hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => state.open }));
vi.mock("../hubApi", () => ({ requestHub: state.request }));
vi.mock("@tanstack/react-router", () => ({ Link: "a", useNavigate: () => state.navigate }));
vi.mock("./ui/sidebar", () => ({ SidebarInset: "main" }));
vi.mock("./ui/button", () => ({ Button: "button" }));
vi.mock("./ui/input", () => ({ Input: "input" }));
import { HubProjectCoordinator, HubProjectPage } from "./HubProjects";
import {
  createHubProject,
  loadHubProjects,
  updateHubProject,
  useHubProjects,
} from "../hubProjects";
import { publishHubEnvironments } from "../hubEnvironments";
let renderer: ReactTestRenderer | undefined;
let storage: Map<string, string>;
const remote = EnvironmentId.make("mbp-native");
const row = { alias: "mbp", label: "MacBook Pro", phase: "unenrolled" as const };
async function render(page = false) {
  await act(async () => {
    const tree = (
      <>
        <HubProjectCoordinator />
        {page && <HubProjectPage alias="mbp" />}
      </>
    );
    if (renderer) renderer.update(tree);
    else renderer = create(tree);
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  state.native = [];
  state.projects = [];
  state.create.mockResolvedValue({ _tag: "Success" });
  state.request.mockResolvedValue({
    ...row,
    phase: "pending",
    approval_url: "https://hub.example/access/requests/test",
  });
  state.navigate.mockResolvedValue(undefined);
  storage = new Map();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  useHubProjects.setState({ projects: [] });
  publishHubEnvironments({ environments: [row], error: null });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it("saves a project before requesting approval, even when its remote has never been installed", async () => {
  await render(true);
  expect(state.request).not.toHaveBeenCalled();
  state.request.mockImplementation(async () => {
    expect(useHubProjects.getState().projects[0]?.workspaceRoot).toBe("~/projects/example");
    expect([...storage.values()].join()).toContain("~/projects/example");
    expect(state.create).not.toHaveBeenCalled();
    return { ...row, phase: "pending" };
  });
  await act(async () =>
    renderer!.root.findByType("input").props.onChange({ target: { value: "~/projects/example" } }),
  );
  await act(async () => renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }));
  expect(state.request).toHaveBeenCalledExactlyOnceWith("environments/mbp/connect", "POST");
  expect(state.create).not.toHaveBeenCalled();
  expect(state.navigate).toHaveBeenCalledWith(
    expect.objectContaining({ to: "/hub/projects/$projectId" }),
  );
});
it("waits for approval and a native remote connection, then creates exactly once on that remote", async () => {
  await render();
  let draft: ReturnType<typeof createHubProject>;
  await act(async () => {
    draft = createHubProject("mbp", "~/projects/example");
  });
  state.native = [
    {
      environmentId: remote,
      displayUrl: "https://hub.example/hub/environments/mbp",
      connection: { phase: "connected" },
    },
  ];
  await render();
  expect(state.create).not.toHaveBeenCalled();
  await act(async () => publishHubEnvironments({ environments: [{ ...row, phase: "pending" }] }));
  expect(state.create).not.toHaveBeenCalled();
  state.native = [{ ...state.native[0]!, connection: { phase: "error" } }];
  await act(async () => publishHubEnvironments({ environments: [{ ...row, phase: "active" }] }));
  expect(state.create).not.toHaveBeenCalled();
  state.native = [{ ...state.native[0]!, connection: { phase: "connected" } }];
  await render();
  expect(state.create).toHaveBeenCalledExactlyOnceWith({
    environmentId: remote,
    input: {
      projectId: draft!.id,
      commandId: draft!.commandId,
      title: "example",
      workspaceRoot: "~/projects/example",
      createWorkspaceRootIfMissing: true,
      defaultModelSelection: null,
    },
  });
  await render();
  expect(state.create).toHaveBeenCalledTimes(1);
  expect(useHubProjects.getState().projects[0]?.phase).toBe("ready");
});
it("retains failed setup across reload without making a grant and preserves command identity on retry", async () => {
  const draft = createHubProject("mbp", "~/projects/example");
  updateHubProject(draft.id, { phase: "creating", environmentId: remote });
  useHubProjects.setState({ projects: [] });
  loadHubProjects();
  expect(useHubProjects.getState().projects[0]).toMatchObject({
    id: draft.id,
    commandId: draft.commandId,
    phase: "waiting",
  });
  await render();
  expect(state.request).not.toHaveBeenCalled();
  expect(state.create).not.toHaveBeenCalled();
  expect(createHubProject("mbp", "~/projects/example").id).toBe(draft.id);
  expect(() => createHubProject("mbp", "relative/path")).toThrow(/absolute/);
  state.native = [
    {
      environmentId: remote,
      displayUrl: "https://hub.example/hub/environments/mbp",
      connection: { phase: "connected" },
    },
  ];
  state.projects = [{ id: draft.id, environmentId: remote }];
  await act(async () => publishHubEnvironments({ environments: [{ ...row, phase: "active" }] }));
  expect(state.create).not.toHaveBeenCalled();
  expect(useHubProjects.getState().projects[0]?.phase).toBe("ready");
});
it("keeps a project after RPC failure and does not retry writes or access automatically", async () => {
  await render();
  state.native = [
    {
      environmentId: remote,
      displayUrl: "https://hub.example/hub/environments/mbp",
      connection: { phase: "connected" },
    },
  ];
  state.create.mockResolvedValue({ _tag: "Failure" });
  await act(async () => {
    publishHubEnvironments({ environments: [{ ...row, phase: "active" }] });
    createHubProject("mbp", "~/projects/example");
  });
  expect(useHubProjects.getState().projects[0]?.phase).toBe("error");
  await render();
  expect(state.create).toHaveBeenCalledTimes(1);
  await act(async () => publishHubEnvironments({ environments: [{ ...row, phase: "locked" }] }));
  await render();
  expect(state.request).not.toHaveBeenCalled();
  expect(useHubProjects.getState().projects).toHaveLength(1);
});
