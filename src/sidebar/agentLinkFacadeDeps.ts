import type { SidebarFacadeDeps } from './sidebarFacadeWiring';

/** Phase 3's inbound routing collaborators, kept out of the sidebar lifecycle owner. */
export function agentLinkFacadeDeps(
  workspaceRoot: string | undefined,
  persistSession: () => void,
  postSessionSync: () => void,
  postConversationNotice: (conversationId: string, message: string) => void,
): Pick<
  SidebarFacadeDeps,
  'workspaceRoot' | 'persistSession' | 'postSessionSync' | 'postConversationNotice'
> {
  return { workspaceRoot, persistSession, postSessionSync, postConversationNotice };
}
