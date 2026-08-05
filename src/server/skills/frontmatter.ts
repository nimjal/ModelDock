/**
 * The `---` block at the top of a SKILL.md.
 *
 * Hand-parsed rather than delegated to a YAML library. That is a scope
 * decision, not a licensing one — `js-yaml` (MIT) and `yaml` (ISC) are both
 * fine to depend on. But the surface a SKILL.md actually uses is `key: value`
 * and `key: [a, b]` in a file people write by hand with three keys in it. A
 * real YAML parser buys anchors, aliases, merge keys and a parser attack
 * surface that nothing here will ever exercise.
 *
 * Two behaviours are deliberate:
 *
 *   - Unknown keys are kept as strings rather than rejected, so a SKILL.md
 *     written for some other tool loads here instead of failing.
 *   - Nothing is silently dropped. A file that cannot be understood becomes a
 *     row with a `problem`, because a skill that vanishes without explanation
 *     is how people stop trusting the feature.
 */

export interface Frontmatter {
  data: Record<string, string | string[]>;
  body: string;
}

const FENCE = /^---\s*$/;
const PAIR = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/;

/** Strip one layer of matching quotes, if present. */
function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function splitInline(value: string): string[] {
  return value
    .slice(1, -1)
    .split(",")
    .map(unquote)
    .filter((item) => item.length > 0);
}

export function parseFrontmatter(text: string): Frontmatter {
  // A UTF-8 BOM ahead of the fence is common enough from Windows editors that
  // failing on it would be a bug report rather than a useful error.
  const source = text.replace(/^﻿/, "");
  const lines = source.split(/\r?\n/);

  if (!lines[0] || !FENCE.test(lines[0])) {
    return { data: {}, body: source };
  }

  const data: Record<string, string | string[]> = {};
  let cursor = 1;
  let lastKey: string | null = null;

  for (; cursor < lines.length; cursor++) {
    const line = lines[cursor]!;
    if (FENCE.test(line)) {
      cursor++;
      break;
    }

    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // A `- item` line continues the previous key as a list.
    if (trimmed.startsWith("- ") && lastKey) {
      const existing = data[lastKey];
      const item = unquote(trimmed.slice(2));
      if (Array.isArray(existing)) existing.push(item);
      else data[lastKey] = [item];
      continue;
    }

    const match = PAIR.exec(trimmed);
    if (!match) continue;

    const [, key, rawValue] = match as unknown as [string, string, string];
    const value = rawValue.trim();
    lastKey = key;

    if (value.startsWith("[") && value.endsWith("]")) {
      data[key] = splitInline(value);
    } else if (value === "") {
      // Either an empty value or the head of a dash list on the next lines.
      data[key] = "";
    } else {
      data[key] = unquote(value);
    }
  }

  return { data, body: lines.slice(cursor).join("\n").trim() };
}

/** Read one frontmatter key as a string, whatever shape it arrived in. */
export function asString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value.join(", ");
  return (value ?? "").trim();
}

/** Read one frontmatter key as a list, accepting a comma-separated string. */
export function asList(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value.map((item) => item.trim()).filter(Boolean);
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
