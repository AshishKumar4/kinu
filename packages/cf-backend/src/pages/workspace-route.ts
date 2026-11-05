/**
 * The workspace page as its own chunk: the chat, its inspector and their surfaces are most of the app's code, and no
 * other page runs them. Home shows it for the assistant, and the workspace routes for the rest; both load it here.
 */
import { lazyRoute } from "@/lazy-route";
import type { WorkspacePageProps } from "./WorkspacePage";

// Named: the page's props default to `{}`, from which the loader's type cannot be inferred.
export const WorkspacePage = lazyRoute<WorkspacePageProps>(async () => import("./WorkspacePage"));
