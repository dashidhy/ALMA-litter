/**
 * Cross-runtime canonical text ordering: strict UTF-8 bytes, unsigned and
 * lexicographic. This must be used anywhere a serialized TAH manifest or
 * deterministic issue list is ordered; ambient locale collation is forbidden.
 */
export function compareCanonicalUTF8V1(left: string, right: string): number {
  const leftBytes = strictUTF8(left);
  const rightBytes = strictUTF8(right);
  return Math.sign(Buffer.compare(leftBytes, rightBytes));
}

export function isCanonicalUTF8V1(value: string): boolean {
  if (typeof value !== "string") return false;
  const bytes = Buffer.from(value, "utf8");
  return bytes.toString("utf8") === value;
}

export function isStrictlyCanonicalUTF8SortedV1(
  values: readonly string[],
): boolean {
  return values.every((value, index) =>
    isCanonicalUTF8V1(value)
      && (index === 0 || compareCanonicalUTF8V1(values[index - 1]!, value) < 0)
  );
}

function strictUTF8(value: string): Buffer {
  if (!isCanonicalUTF8V1(value)) {
    throw new TypeError("Canonical text contains an invalid Unicode scalar sequence");
  }
  return Buffer.from(value, "utf8");
}
