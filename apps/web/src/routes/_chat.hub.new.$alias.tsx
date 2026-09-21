import { createFileRoute } from "@tanstack/react-router";
import { HubProjectPage } from "../components/HubProjects";

export const Route = createFileRoute("/_chat/hub/new/$alias")({
  component: () => <HubProjectPage alias={Route.useParams().alias} />,
});
