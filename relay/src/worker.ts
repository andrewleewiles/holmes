import { RelaySlot } from './slot.ts'

export { RelaySlot }

export interface Env {
  SLOT: DurableObjectNamespace
}

const ROUTE = /^\/(s|c)\/([a-z2-7]{26})$/

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/healthz') return new Response('ok')

    const route = ROUTE.exec(url.pathname)
    if (!route) return new Response('Not found', { status: 404 })

    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 })
    }

    // idFromName is deterministic, so the Mac and the phone reach the same
    // object without the relay keeping any registry of identifiers.
    const stub = env.SLOT.get(env.SLOT.idFromName(route[2]))
    return stub.fetch(request)
  },
} satisfies ExportedHandler<Env>
