import { inflateRawSync } from 'zlib';

const MAX_ZIP_ENTRIES = 5_000;
const MAX_ZIP_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;

/** Resolve an OPC relationship Target relative to its source part. */
export function resolveOpcTarget(sourcePart: string, target: string): string {
  const stack = target.startsWith('/') ? [] : sourcePart.split('/').slice(0, -1);
  for (const piece of target.split('/')) {
    if (piece === '..') stack.pop();
    else if (piece !== '.' && piece !== '') stack.push(piece);
  }
  return stack.join('/');
}

interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

function locateDirectory(bytes: Buffer): number {
  const minimum = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= minimum; offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error('ZIP central directory: end record is missing or malformed.');
}

function entriesFrom(bytes: Buffer): ZipEntry[] {
  const end = locateDirectory(bytes);
  const count = bytes.readUInt16LE(end + 10);
  const directorySize = bytes.readUInt32LE(end + 12);
  let offset = bytes.readUInt32LE(end + 16);
  if (count === 0xffff || offset === 0xffffffff || directorySize === 0xffffffff)
    throw new Error('ZIP central directory: ZIP64 archives are not supported.');
  if (count > MAX_ZIP_ENTRIES)
    throw new Error(
      `ZIP central directory: ${count} entries exceeds the ${MAX_ZIP_ENTRIES} limit.`,
    );
  if (offset + directorySize > bytes.length)
    throw new Error('ZIP central directory: directory extends past end of file.');
  const entries: ZipEntry[] = [];
  let total = 0;
  for (let index = 0; index < count; index++) {
    // Every offset below comes from the archive, so a truncated or crafted one
    // has to be refused here, by name: read past the end and Node answers with
    // its own "outside buffer bounds" RangeError instead, which tells the model
    // nothing about the file and how to get a readable one. Checking the 46-byte
    // fixed header once covers every read below it.
    if (offset + 46 > bytes.length)
      throw new Error(`ZIP central directory: truncated entry ${index + 1}.`);
    if (bytes.readUInt32LE(offset) !== 0x02014b50)
      throw new Error(`ZIP central directory: malformed entry ${index + 1}.`);
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > bytes.length) throw new Error(`ZIP central directory: truncated entry ${index + 1}.`);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if ((flags & 1) !== 0)
      throw new Error(`ZIP entry "${name}" is encrypted; encrypted Office files are unsupported.`);
    if (size > 100 * compressedSize && size > 0)
      throw new Error(`ZIP entry "${name}" exceeds the 100:1 compression ratio limit.`);
    total += size;
    if (total > MAX_ZIP_UNCOMPRESSED_BYTES)
      throw new Error(
        `ZIP archive exceeds the ${MAX_ZIP_UNCOMPRESSED_BYTES / 1024 / 1024} MB uncompressed limit.`,
      );
    entries.push({ name, method, flags, compressedSize, size, localOffset });
    offset = end;
  }
  return entries;
}

export function unzipTextParts(
  bytes: Buffer,
  include: (name: string) => boolean,
  abortSignal?: AbortSignal,
): Map<string, string> {
  const entries = entriesFrom(bytes);
  const output = new Map<string, string>();
  for (const entry of entries) {
    if (abortSignal?.aborted) throw new Error('Document parsing cancelled.');
    if (entry.name.endsWith('/')) continue;
    const name = entry.name.replace(/\\/g, '/');
    if (!include(name)) continue;
    const offset = entry.localOffset;
    // The offset is the archive's promise, not a fact: a central entry can name
    // a position past the end of the file, and reading its signature there is
    // the RangeError again. Same reason as in `entriesFrom`.
    if (offset + 30 > bytes.length)
      throw new Error(`ZIP part "${entry.name}": local header is past the end of the file.`);
    if (bytes.readUInt32LE(offset) !== 0x04034b50)
      throw new Error(`ZIP part "${entry.name}": local header is malformed.`);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const start = offset + 30 + nameLength + extraLength;
    const end = start + entry.compressedSize;
    if (end > bytes.length)
      throw new Error(`ZIP part "${entry.name}": compressed data is truncated.`);
    try {
      const compressed = bytes.subarray(start, end);
      const data =
        entry.method === 0
          ? compressed
          : entry.method === 8
            ? inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.size) })
            : undefined;
      if (!data) throw new Error(`unsupported compression method ${entry.method}`);
      if (data.length !== entry.size)
        throw new Error('uncompressed size does not match the directory');
      output.set(name, data.toString('utf8'));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`ZIP part "${entry.name}": ${message}.`);
    }
  }
  return output;
}

export function xmlElements(xml: string, tag: string): string[] {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    ...xml.matchAll(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)</${escaped}\\s*>`, 'g')),
  ].map((m) => m[1] ?? '');
}

export function xmlAttr(tag: string, attr: string): string | undefined {
  const escaped = attr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return tag.match(new RegExp(`(?:^|\\s)${escaped}="([^"]*)"`))?.[1];
}

export function xmlText(xml: string): string {
  return xml
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export function requiredPart(parts: Map<string, string>, name: string): string {
  const value = parts.get(name);
  if (value === undefined)
    throw new Error(`ZIP part "${name}": required document part is missing.`);
  return value;
}
