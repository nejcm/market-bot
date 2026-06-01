export function parseSections(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const regex = /^## (.+)$/gmu;
  const positions: { readonly heading: string; readonly start: number }[] = [];

  let match: RegExpExecArray | null = regex.exec(content);
  while (match !== null) {
    positions.push({ heading: (match[1] ?? "").trim().toLowerCase(), start: match.index });
    match = regex.exec(content);
  }

  for (let i = 0; i < positions.length; i += 1) {
    const current = positions[i];
    const next = positions[i + 1];
    if (current !== undefined) {
      const bodyStart = content.indexOf("\n", current.start) + 1;
      const bodyEnd = next !== undefined ? next.start : content.length;
      result[current.heading] = content.slice(bodyStart, bodyEnd).trim();
    }
  }

  return result;
}
