import { BrowserWindow } from 'electron'
import { isRemoteEvent } from '../shared/remote'

export interface CallerSender {
  id: number
  isDestroyed(): boolean
  send(channel: string, ...args: unknown[]): void
  once(event: 'destroyed', listener: () => void): void
  removeListener(event: 'destroyed', listener: () => void): void
}

export interface CallerEvent {
  sender: CallerSender
  senderFrame?: { url: string } | null
  remote?: { deviceId: string } | null
}

export type IpcHandler = (event: CallerEvent, ...args: any[]) => unknown

const handlers = new Map<string, IpcHandler>()

export function registerHandler(channel: string, handler: IpcHandler): void {
  handlers.set(channel, handler)
}

export function getHandler(channel: string): IpcHandler | undefined {
  return handlers.get(channel)
}

export function isRemoteCaller(event: CallerEvent): boolean {
  return !!event.remote
}

type Forwarder = (channel: string, args: unknown[]) => void

let forwarder: Forwarder | null = null

export function setRemoteForwarder(fn: Forwarder | null): void {
  forwarder = fn
}

/**
 * Replaces `win.webContents.send` at every broadcast site. A paired device only
 * receives channels named in REMOTE_EVENT_CHANNELS, so adding a broadcast does
 * not silently start shipping it off the machine.
 */
export function broadcast(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue
      win.webContents.send(channel, ...args)
    } catch { /* A window closing mid-broadcast is not an error. */ }
  }
  if (forwarder && isRemoteEvent(channel)) forwarder(channel, args)
}
