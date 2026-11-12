// A minimal, line-based TOML editor for the one shape appliers need: a single-line `key = value`
// inside a standard `[table]`. Everything else in the file (comments, ordering, formatting) is kept
// byte for byte. Layouts it can't edit safely (the table split across dotted keys or an inline
// table, a multi-line value) are refused with a reason rather than guessed at.

const HEADER = /^\s*\[([^[\]]+)\]\s*(#.*)?$/;
const ARRAY_HEADER = /^\s*\[\[/;

/** `patch."crates-io"` → `patch.crates-io` (quotes and spaces around dots removed). */
const normTable = (t: string) =>
  t
    .split('.')
    .map((p) =>
      p
        .trim()
        .replace(/^"(.*)"$/, '$1')
        .replace(/^'(.*)'$/, '$1'),
    )
    .join('.');

const keyPattern = (key: string) => new RegExp(`^\\s*(?:${escape(key)}|"${escape(key)}"|'${escape(key)}')\\s*=`);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface Located {
  lines: string[];
  /** Index of the header line, or -1. */
  header: number;
  /** One past the table's last line. */
  end: number;
}

function locate(text: string, table: string): Located {
  const lines = text.split('\n');
  const want = normTable(table);
  let header = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const m = HEADER.exec(lines[i]!);
    const isHeader = !!m || ARRAY_HEADER.test(lines[i]!);
    if (header >= 0 && isHeader) {
      end = i;
      break;
    }
    if (m && !ARRAY_HEADER.test(lines[i]!) && normTable(m[1]!) === want) header = i;
  }
  return { lines, header, end };
}

/** Refuse layouts where the table's keys could also be defined elsewhere. */
function assertEditable(text: string, table: string, file: string): void {
  const parts = normTable(table).split('.');
  for (let i = 1; i < parts.length; i++) {
    const parent = parts.slice(0, i).join('.');
    const rest = parts.slice(i).join('.');
    const { lines, header, end } = locate(text, parent);
    if (header < 0) continue;
    const head = rest.split('.')[0]!;
    if (lines.slice(header + 1, end).some((l) => new RegExp(`^\\s*"?${escape(head)}"?\\s*[.=]`).test(l))) {
      throw new Error(
        `${file}: [${table}] is written as dotted keys or an inline table under [${parent}]; write it as a [${table}] table so Graft can edit it`,
      );
    }
  }
  const top = locate(text, '__graft_top__');
  const firstHeader = top.lines.findIndex((l) => HEADER.test(l) || ARRAY_HEADER.test(l));
  const preamble = top.lines.slice(0, firstHeader < 0 ? top.lines.length : firstHeader);
  if (preamble.some((l) => new RegExp(`^\\s*"?${escape(parts[0]!)}"?\\s*[.=]`).test(l))) {
    throw new Error(
      `${file}: ${parts[0]} is defined with dotted keys at the top level; write it as a [${table}] table so Graft can edit it`,
    );
  }
}

/** The raw value of `key` in `[table]`, or undefined. */
export function getTomlValue(text: string, table: string, key: string): string | undefined {
  const { lines, header, end } = locate(text, table);
  if (header < 0) return undefined;
  const line = lines.slice(header + 1, end).find((l) => keyPattern(key).test(l));
  return line
    ?.replace(keyPattern(key), '')
    .replace(/\s+#[^"']*$/, '')
    .trim();
}

/** Keys of `[table]`, in file order. */
export function getTomlKeys(text: string, table: string): string[] {
  const { lines, header, end } = locate(text, table);
  if (header < 0) return [];
  return lines
    .slice(header + 1, end)
    .map((l) => /^\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*=/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => m[1] ?? m[2] ?? m[3]!);
}

/** Set `key = value` (value is raw TOML, single-line) in `[table]`, creating the table at the end if needed. */
export function setTomlValue(text: string, table: string, key: string, value: string, file = 'TOML file'): string {
  assertEditable(text, table, file);
  const { lines, header, end } = locate(text, table);
  const entry = `${/^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key)} = ${value}`;
  if (header < 0) {
    const body = text.replace(/\n*$/, '');
    return `${body}${body ? '\n\n' : ''}[${table}]\n${entry}\n`;
  }
  const at = lines.slice(header + 1, end).findIndex((l) => keyPattern(key).test(l));
  if (at >= 0) {
    const line = lines[header + 1 + at]!;
    const opens = (line.match(/[{[]/g) ?? []).length;
    const closes = (line.match(/[}\]]/g) ?? []).length;
    if (opens !== closes) throw new Error(`${file}: ${table}.${key} spans several lines; put it on one line so Graft can edit it`);
    lines[header + 1 + at] = entry;
    return lines.join('\n');
  }
  let last = end - 1;
  while (last > header && !lines[last]!.trim()) last--;
  lines.splice(last + 1, 0, entry);
  return lines.join('\n');
}

/** Remove `key` from `[table]` (and the table header when nothing but blank lines and comments is left). */
export function removeTomlValue(text: string, table: string, key: string): string {
  const { lines, header, end } = locate(text, table);
  if (header < 0) return text;
  const at = lines.slice(header + 1, end).findIndex((l) => keyPattern(key).test(l));
  if (at < 0) return text;
  lines.splice(header + 1 + at, 1);
  const rest = lines.slice(header + 1, end - 1);
  if (rest.every((l) => !l.trim())) lines.splice(header, end - 1 - header);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** The string value of `field` in a single-line inline table (`{ path = "x", version = "1" }`). */
export function inlineTableString(value: string | undefined, field: string): string | undefined {
  if (!value) return undefined;
  const m = new RegExp(`(?:^|[{,\\s])${escape(field)}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|'([^']*)')`).exec(value);
  return m ? (m[1] !== undefined ? JSON.parse(`"${m[1]}"`) : m[2]) : undefined;
}
