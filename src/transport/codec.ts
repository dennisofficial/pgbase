import { JSON_NULL } from '../query/compare.js';
import { PgbaseWireCodec, type WireCodec } from '../read/index.js';
import type { WalEvent } from '../wal/types.js';

function createTransportCodec(): WireCodec {
  const codec = new PgbaseWireCodec();
  codec.registerSymbol(JSON_NULL, 'pgbase.jsonNull');
  return codec;
}

const codec = createTransportCodec();

export function encodeEvent(event: WalEvent): string {
  return JSON.stringify(codec.serialize(event));
}

export function decodeEvent(payload: string): WalEvent {
  return codec.deserialize(JSON.parse(payload)) as WalEvent;
}

export function payloadByteLength(payload: string): number {
  return Buffer.byteLength(payload, 'utf8');
}
