// Offline reader for the EntityProto/LevelDB-log format emitted by Firestore
// emulator 1.22. Unknown encodings fail closed; this never starts an emulator.
import assert from "node:assert/strict";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = (n >>> 1) ^ ((n & 1) ? 0x82f63b78 : 0);
  return n >>> 0;
});
export function maskedCrc(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) crc = crcTable[(crc ^ b) & 255] ^ (crc >>> 8);
  crc = (~crc) >>> 0;
  return (((crc >>> 15) | (crc << 17)) + 0xa282ead8) >>> 0;
}

function varint(bytes, cursor) {
  let n = 0n;
  for (let shift = 0n; shift < 70n; shift += 7n) {
    assert.ok(cursor.p < bytes.length, "Truncated protobuf varint");
    const b = bytes[cursor.p++];
    n |= BigInt(b & 127) << shift;
    if (!(b & 128)) return n;
  }
  throw new Error("Oversized protobuf varint");
}

function fields(bytes, cursor = { p: 0 }, group = null, depth = 0) {
  assert.ok(depth < 80, "Export nesting is too deep");
  const result = [];
  while (cursor.p < bytes.length) {
    const tag = Number(varint(bytes, cursor)), id = tag >>> 3, wire = tag & 7;
    assert.ok(id > 0, "Invalid protobuf field");
    if (wire === 4) {
      assert.equal(id, group, "Mismatched protobuf group");
      return result;
    }
    let value;
    if (wire === 0) value = varint(bytes, cursor);
    else if (wire === 3) value = fields(bytes, cursor, id, depth + 1);
    else if ([1, 2, 5].includes(wire)) {
      const size = wire === 2 ? Number(varint(bytes, cursor)) : wire === 1 ? 8 : 4;
      assert.ok(Number.isSafeInteger(size) && size >= 0 && cursor.p + size <= bytes.length, "Truncated protobuf field");
      value = bytes.subarray(cursor.p, cursor.p + size);
      cursor.p += size;
    } else throw new Error(`Unsupported protobuf wire type ${wire}`);
    result.push({ id, wire, value });
  }
  assert.equal(group, null, "Unterminated protobuf group");
  return result;
}
const one = (items, id) => items.find(item => item.id === id)?.value;
const utf8 = bytes => {
  assert.ok(Buffer.isBuffer(bytes), "Expected protobuf string");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
};
function integer(n) {
  const value = Number(BigInt.asIntN(64, n));
  assert.ok(Number.isSafeInteger(value), "Export integer exceeds safe precision");
  return value;
}

function entity(bytes, depth = 0) {
  assert.ok(depth < 60, "Entity nesting is too deep");
  const parts = fields(bytes), data = Object.create(null);
  for (const part of parts.filter(item => item.id === 14 || item.id === 15)) {
    const property = fields(part.value), name = utf8(one(property, 3));
    const meaning = Number(one(property, 1) ?? 0n), multiple = one(property, 4) === 1n;
    const values = fields(one(property, 5) ?? Buffer.alloc(0));
    let value;
    if (meaning === 24) value = []; // EMPTY_LIST
    else if (!values.length) value = null;
    else if (meaning === 19) value = entity(one(values, 3), depth + 1).data;
    else if (meaning === 7) { // GD_WHEN: integer microseconds
      const micros = one(values, 1);
      assert.equal(typeof micros, "bigint", "Invalid export timestamp");
      const millis = Number(micros / 1000n);
      assert.ok(Number.isSafeInteger(millis), "Invalid export timestamp precision");
      value = new Date(millis).toISOString();
    } else if (one(values, 3) !== undefined && [0, 1, 2, 3, 4].includes(meaning)) value = utf8(one(values, 3));
    else if (one(values, 1) !== undefined && meaning === 0) value = integer(one(values, 1));
    else if (one(values, 2) !== undefined && meaning === 0) value = one(values, 2) === 1n;
    else if (one(values, 4) !== undefined && meaning === 0) value = one(values, 4).readDoubleLE();
    else throw new Error(`Unsupported exported property encoding (meaning ${meaning})`);
    if (multiple && meaning !== 24) {
      data[name] ??= [];
      assert.ok(Array.isArray(data[name]), "Conflicting export property cardinality");
      data[name].push(value);
    } else {
      assert.ok(!Object.hasOwn(data, name), "Duplicate export property");
      data[name] = value;
    }
  }
  if (depth > 0) return { data, projectId: null, path: null };
  const referenceBytes = one(parts, 13);
  if (!referenceBytes) return { data, projectId: null, path: null };
  const reference = fields(referenceBytes);
  const app = utf8(one(reference, 13));
  const projectId = app.startsWith("dev~") ? app.slice(4) : app;
  const pathBytes = one(reference, 14);
  const segments = fields(pathBytes).filter(item => item.id === 1 && item.wire === 3).flatMap(item => {
    const kind = utf8(one(item.value, 2));
    const name = one(item.value, 4);
    assert.ok(name, "Numeric document keys are unsupported");
    const id = utf8(name);
    assert.ok(kind && id && !kind.includes("/") && !id.includes("/"), "Invalid document key");
    return [kind, id];
  });
  assert.ok(segments.length >= 2, "Missing document key");
  return { projectId, path: segments.join("/"), data };
}

export function readLogRecords(bytes) {
  let offset = 0, fragments = null;
  const records = [];
  while (offset < bytes.length) {
    const remaining = 32768 - (offset % 32768);
    if (remaining < 7) {
      assert.ok(bytes.subarray(offset, Math.min(bytes.length, offset + remaining)).every(b => b === 0), "Invalid log trailer");
      offset += remaining;
      continue;
    }
    assert.ok(offset + 7 <= bytes.length, "Truncated log header");
    const crc = bytes.readUInt32LE(offset), size = bytes.readUInt16LE(offset + 4), type = bytes[offset + 6];
    if (crc === 0 && size === 0 && type === 0) {
      assert.ok(bytes.subarray(offset, Math.min(bytes.length, offset + remaining)).every(b => b === 0), "Invalid log padding");
      offset += remaining;
      continue;
    }
    assert.ok(size + 7 <= remaining && offset + 7 + size <= bytes.length, "Truncated or crossing log record");
    const payload = bytes.subarray(offset + 7, offset + 7 + size);
    assert.equal(maskedCrc(Buffer.concat([Buffer.from([type]), payload])), crc, "Firestore export checksum mismatch");
    if (type === 1) {
      assert.equal(fragments, null, "Interrupted fragmented record");
      records.push(payload);
    } else if (type === 2) {
      assert.equal(fragments, null, "Overlapping fragmented records");
      fragments = [payload];
    } else if (type === 3 || type === 4) {
      assert.ok(fragments, "Orphaned record fragment");
      fragments.push(payload);
      if (type === 4) { records.push(Buffer.concat(fragments)); fragments = null; }
    } else throw new Error(`Unsupported log record type ${type}`);
    offset += 7 + size;
  }
  assert.equal(fragments, null, "Truncated fragmented export");
  return records;
}

export const decodeFirestoreLog = bytes => readLogRecords(bytes).map(record => entity(record));

export function overallMetadata(bytes) {
  const records = readLogRecords(bytes);
  assert.equal(records.length, 2, "Unsupported overall export metadata layout");
  assert.equal(records[0].toString(), "3", "Unsupported overall export metadata version");
  const parsed = fields(records[1]);
  const kinds = parsed.filter(p => p.id === 1).map(p => fields(p.value));
  assert.ok(kinds.length, "Overall export kinds are missing");
  const counts = kinds.map(kind => one(kind, 3));
  assert.ok(counts.every(count => typeof count === "bigint"), "Overall export document count is missing");
  return {
    documentCount: counts.reduce((sum, count) => sum + integer(count), 0),
    kindFiles: kinds.map(kind => utf8(one(kind, 2)).replaceAll("\\", "/")),
  };
}

export function kindShards(bytes) {
  const parsed = fields(bytes);
  assert.ok(one(parsed, 1), "Incomplete kind export metadata");
  return parsed.filter(p => p.id === 2).map(p => utf8(one(fields(p.value), 2)).replaceAll("\\", "/"));
}
