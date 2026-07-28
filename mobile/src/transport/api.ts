import { IPC } from '../../../src/main/ipcChannels'
import type { RemoteClientSettings } from '@shared/remote'
import type {
  ContextSelection,
  Conversation,
  Message,
  ModelInfo,
  Project,
  ReasoningEffort,
  RoleSummary,
  StreamChunk,
  TimelineEvent,
  TimelineFilter,
  UserSuperContext,
  Person,
  ProjectIndexSummary,
} from '@shared/types'
import { remoteClient } from './client'

/**
 * The same shape the preload exposes, minus everything the allowlist denies.
 * Types come from the desktop, so a change there fails this build.
 */
export const api = {
  clientSettings: () => remoteClient.call<RemoteClientSettings>(IPC.REMOTE.CLIENT_SETTINGS),

  conversations: {
    list: () => remoteClient.call<Conversation[]>(IPC.CONVERSATIONS.LIST),
    create: (model?: string, effort?: ReasoningEffort, projectId?: string) =>
      remoteClient.call<Conversation>(IPC.CONVERSATIONS.CREATE, model, effort, projectId),
    delete: (id: string) => remoteClient.call<void>(IPC.CONVERSATIONS.DELETE, id),
    rename: (id: string, title: string) => remoteClient.call<void>(IPC.CONVERSATIONS.RENAME, id, title),
    getMessages: (id: string) => remoteClient.call<Message[]>(IPC.CONVERSATIONS.GET_MESSAGES, id),
    updateModel: (id: string, model: string) => remoteClient.call<void>(IPC.CONVERSATIONS.UPDATE_MODEL, id, model),
    updateContext: (id: string, context: ContextSelection) =>
      remoteClient.call<void>(IPC.CONVERSATIONS.UPDATE_CONTEXT, id, context),
    updateRole: (id: string, roleId: string | null) =>
      remoteClient.call<void>(IPC.CONVERSATIONS.UPDATE_ROLE, id, roleId),
  },

  chat: {
    send: (
      conversationId: string,
      message: string,
      model: string,
      effort?: ReasoningEffort,
      memoryMode?: string,
      context?: ContextSelection
    ) => remoteClient.call<void>(IPC.CHAT.SEND, conversationId, message, model, effort, memoryMode, context),
    abort: () => remoteClient.call<void>(IPC.CHAT.ABORT),
    retry: (messageId: string, model: string, effort?: ReasoningEffort) =>
      remoteClient.call<void>(IPC.CHAT.RETRY_MESSAGE, messageId, model, effort),
  },

  models: {
    list: () => remoteClient.call<ModelInfo[]>(IPC.MODELS.LIST),
  },

  roles: {
    list: () => remoteClient.call<RoleSummary[]>(IPC.ROLES.LIST),
  },

  projects: {
    list: () => remoteClient.call<Project[]>(IPC.PROJECTS.LIST),
  },

  documents: {
    summaries: () => remoteClient.call<ProjectIndexSummary[]>(IPC.DOCUMENTS.GET_SUMMARIES),
    userContext: () => remoteClient.call<UserSuperContext | null>(IPC.DOCUMENTS.GET_USER_CONTEXT),
  },

  timeline: {
    list: (filter?: TimelineFilter) => remoteClient.call<TimelineEvent[]>(IPC.TIMELINE.LIST, filter),
  },

  people: {
    list: () => remoteClient.call<Person[]>(IPC.PEOPLE.LIST),
  },
}

export function onStreamChunk(listener: (chunk: StreamChunk) => void): () => void {
  return remoteClient.onEvent((channel, args) => {
    if (channel === IPC.CHAT.STREAM_CHUNK || channel === IPC.CHAT.STREAM_DONE) {
      listener(args[0] as StreamChunk)
    }
  })
}

export function onConversationsUpdated(listener: () => void): () => void {
  return remoteClient.onEvent((channel) => {
    if (channel === IPC.CONVERSATIONS.UPDATED) listener()
  })
}
