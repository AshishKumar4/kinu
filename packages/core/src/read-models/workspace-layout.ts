/**
 * How a workspace's page is laid out: `workbench`, its chats as tabs beside the inspector; or `focus`, the chat alone,
 * its tabs, inspector and agents a click away. The workspace keeps it (its root's `layout` config), so a blueprint can
 * set it and every browser shows it the same.
 */
import * as v from 'valibot';

export const WORKSPACE_LAYOUTS = ['workbench', 'focus'] as const;

export type WorkspaceLayout = (typeof WORKSPACE_LAYOUTS)[number];

export const WorkspaceLayoutSchema = v.picklist(WORKSPACE_LAYOUTS);

/** The root actor's config key. */
export const WORKSPACE_LAYOUT_CONFIG_KEY = 'layout';
