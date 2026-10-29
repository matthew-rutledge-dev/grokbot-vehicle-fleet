/**
 * Minimal protobuf wire-format writer and reader for the few Vehicle Command
 * Protocol messages this server builds by hand (no codegen dependency).
 *
 * Field numbers come from teslamotors/vehicle-command (Apache-2.0):
 * pkg/protocol/protobuf/{universal_message,signatures,car_server}.proto.
 * VehicleAction.videoRequestAction = 57, dashcamSaveClipAction = 47 and boomboxAction = 64 are NOT in
 * the official protos; they are community-documented (Teslemetry/tesla-protocol,
 * Apache-2.0, marked TESLEMETRY-EXT there). See THIRD_PARTY_NOTICES.md.
 */

const WT_VARINT = 0;
const WT_FIXED64 = 1;
const WT_LEN = 2;
const WT_FIXED32 = 5;

export class ProtoWriter {
  private parts: Buffer[] = [];

  private raw(b: Buffer): this {
    this.parts.push(b);
    return this;
  }

  private tag(field: number, wt: number): this {
    return this.raw(encodeVarint(field * 8 + wt));
  }

  /** uint32 / enum varint field; proto3 default (0) is omitted. */
  uint32(field: number, v: number): this {
    if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new RangeError(`uint32 out of range: ${v}`);
    if (v === 0) return this;
    return this.tag(field, WT_VARINT).raw(encodeVarint(v));
  }

  /** fixed32 field; proto3 default (0) is omitted. */
  fixed32(field: number, v: number): this {
    if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new RangeError(`fixed32 out of range: ${v}`);
    if (v === 0) return this;
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v);
    return this.tag(field, WT_FIXED32).raw(b);
  }

  /** bytes field; empty is omitted unless `always` (oneof members are always written). */
  bytes(field: number, v: Uint8Array, always = false): this {
    if (v.length === 0 && !always) return this;
    return this.tag(field, WT_LEN).raw(encodeVarint(v.length)).raw(Buffer.from(v));
  }

  string(field: number, v: string, always = false): this {
    return this.bytes(field, Buffer.from(v, "utf8"), always);
  }

  /** Embedded message (always written: used for set oneof members and present submessages). */
  message(field: number, w: ProtoWriter): this {
    return this.bytes(field, w.finish(), true);
  }

  finish(): Buffer {
    return Buffer.concat(this.parts);
  }
}

export function encodeVarint(n: number): Buffer {
  if (!Number.isInteger(n) || n < 0 || n > Number.MAX_SAFE_INTEGER) throw new RangeError(`varint out of range: ${n}`);
  const out: number[] = [];
  let v = n;
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
  return Buffer.from(out);
}

export type ProtoField = { field: number; wt: number; varint?: number; bytes?: Buffer; fixed32?: number };

export class ProtoDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtoDecodeError";
  }
}

const MAX_MESSAGE_BYTES = 1 << 20;

/** Parse one message level into fields (unknown fields kept; groups rejected). */
export function decodeFields(buf: Uint8Array): ProtoField[] {
  if (buf.length > MAX_MESSAGE_BYTES) throw new ProtoDecodeError("message too large");
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  const out: ProtoField[] = [];
  let i = 0;
  const varint = (): number => {
    let result = 0;
    let mul = 1;
    for (let n = 0; n < 10; n++) {
      if (i >= b.length) throw new ProtoDecodeError("truncated varint");
      const byte = b[i++];
      result += (byte & 0x7f) * mul;
      if (result > Number.MAX_SAFE_INTEGER) throw new ProtoDecodeError("varint too large");
      if ((byte & 0x80) === 0) return result;
      mul *= 0x80;
    }
    throw new ProtoDecodeError("varint too long");
  };
  while (i < b.length) {
    const key = varint();
    const field = Math.floor(key / 8);
    const wt = key % 8;
    if (field === 0) throw new ProtoDecodeError("field number 0");
    if (wt === WT_VARINT) out.push({ field, wt, varint: varint() });
    else if (wt === WT_LEN) {
      const len = varint();
      if (i + len > b.length) throw new ProtoDecodeError("truncated length-delimited field");
      out.push({ field, wt, bytes: Buffer.from(b.subarray(i, i + len)) });
      i += len;
    } else if (wt === WT_FIXED32) {
      if (i + 4 > b.length) throw new ProtoDecodeError("truncated fixed32");
      out.push({ field, wt, fixed32: b.readUInt32LE(i) });
      i += 4;
    } else if (wt === WT_FIXED64) {
      if (i + 8 > b.length) throw new ProtoDecodeError("truncated fixed64");
      i += 8; // not used by any message read here
    } else {
      throw new ProtoDecodeError(`unsupported wire type ${wt}`);
    }
  }
  return out;
}

/** Last occurrence wins (protobuf merge semantics for scalars). */
export function getField(fields: ProtoField[], n: number): ProtoField | undefined {
  for (let k = fields.length - 1; k >= 0; k--) if (fields[k].field === n) return fields[k];
  return undefined;
}

export function getBytes(fields: ProtoField[], n: number): Buffer | undefined {
  const f = getField(fields, n);
  if (f && f.wt !== WT_LEN) throw new ProtoDecodeError(`field ${n}: expected bytes`);
  return f?.bytes;
}

export function getUint(fields: ProtoField[], n: number): number {
  const f = getField(fields, n);
  if (!f) return 0;
  if (f.wt === WT_VARINT) return f.varint ?? 0;
  if (f.wt === WT_FIXED32) return f.fixed32 ?? 0;
  throw new ProtoDecodeError(`field ${n}: expected an integer`);
}

export function getMessage(fields: ProtoField[], n: number): ProtoField[] | undefined {
  const b = getBytes(fields, n);
  return b === undefined ? undefined : decodeFields(b);
}
