import { WalDecodeError } from './types.js';

export const textDecoder = new TextDecoder();

export class BinaryReader {
  private pos = 0;

  constructor(private readonly buf: Buffer) {}

  private need(n: number): void {
    if (this.buf.length < this.pos + n) {
      throw new WalDecodeError(null, 'pgoutput message ended before an expected field.');
    }
  }

  readUint8(): number {
    this.need(1);
    return this.buf[this.pos++]!;
  }

  readInt16(): number {
    this.need(2);
    const v = (this.buf[this.pos]! << 8) | this.buf[this.pos + 1]!;
    this.pos += 2;
    return v;
  }

  readInt32(): number {
    this.need(4);
    const v = this.buf.readInt32BE(this.pos);
    this.pos += 4;
    return v;
  }

  readUint32(): number {
    this.need(4);
    const v = this.buf.readUInt32BE(this.pos);
    this.pos += 4;
    return v;
  }

  readUint64(): bigint {
    this.need(8);
    const v = this.buf.readBigUInt64BE(this.pos);
    this.pos += 8;
    return v;
  }

  readBytes(n: number): Buffer {
    this.need(n);
    const v = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }

  readString(): string {
    const end = this.buf.indexOf(0x00, this.pos);
    if (end < 0) throw new WalDecodeError(null, 'pgoutput message: unterminated string field.');
    const v = textDecoder.decode(this.buf.subarray(this.pos, end));
    this.pos = end + 1;
    return v;
  }

  /** LSN wire format: two uint32s, rendered as Postgres's canonical "HEX/HEX" text form. */
  readLsn(): string {
    const hi = this.readUint32();
    const lo = this.readUint32();
    return `${hi.toString(16).toUpperCase()}/${lo.toString(16).toUpperCase()}`;
  }

  /** Microseconds since the Postgres epoch (2000-01-01), converted to microseconds since the
   * Unix epoch — the same bigint representation `parseTimestampMicros` produces. */
  readTime(): bigint {
    return this.readUint64() + 946_684_800_000_000n;
  }
}
