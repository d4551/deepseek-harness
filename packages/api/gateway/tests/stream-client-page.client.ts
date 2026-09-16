import { RemoteStreamMuxClient } from '../src/client/stream-client.ts'

declare global {
  interface Window {
    streamClient: RemoteStreamMuxClient
    streamCancellation: AbortController
  }
}

window.streamClient = new RemoteStreamMuxClient()
window.streamCancellation = new AbortController()
