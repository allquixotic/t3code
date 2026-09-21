import { createFileRoute } from "@tanstack/react-router";
import { HubProjectPage } from "../components/HubProjects";

export const Route = createFileRoute("/_chat/hub/projects/$projectId")({
  component: () => <HubProjectPage projectId={Route.useParams().projectId} />,
});
