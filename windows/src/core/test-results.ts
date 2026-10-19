// SPDX-License-Identifier: MIT
export interface CodingTestResults {
  passed?: number; failed?: number; skipped?: number; total?: number;
  cases: { name: string; status: "passed" | "failed"; kind: "suite" | "test" }[];
}

/** The relay supplies only bounded summaries and reported case/suite names. */
export function reportedTestResults(value: unknown): CodingTestResults | undefined {
  if (!value || typeof value !== "object") return;
  const source = value as Record<string, unknown>, result: CodingTestResults = { cases: [] };
  for (const key of ["passed", "failed", "skipped", "total"] as const) {
    const count = source[key];
    if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0 && count <= 1_000_000) result[key] = count;
  }
  if (Array.isArray(source.cases)) for (const item of source.cases.slice(0, 32)) {
    if (!item || typeof item.name !== "string" || !["passed", "failed"].includes(item.status)
      || !["suite", "test"].includes(item.kind)) continue;
    const name = item.name.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 160);
    if (!name) continue;
    const index = result.cases.findIndex(existing => existing.name === name && existing.kind === item.kind);
    const entry = { name, status: item.status, kind: item.kind };
    if (index >= 0) result.cases[index] = entry;
    else result.cases.push(entry);
  }
  return Object.keys(result).length > 1 || result.cases.length ? result : undefined;
}

/** Older hooks can still display counts explicitly present in their short preview. */
export function testResultsFromLines(lines: string[]): CodingTestResults | undefined {
  const result: CodingTestResults = { cases: [] };
  for (const raw of lines.slice(0, 12)) {
    const line = raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trim();
    if (/^(?:Tests(?::|\s)|test result:|[#ℹ]\s*(?:tests|pass|fail|skipped)\s)/i.test(line)) {
      for (const key of ["passed", "failed", "skipped", "total"] as const) {
        const value = line.match(new RegExp(`(\\d+)\\s+${key}\\b`, "i"));
        if (value) result[key] = Number(value[1]);
      }
      for (const [label, key] of [["tests", "total"], ["pass", "passed"], ["fail", "failed"], ["skipped", "skipped"]] as const) {
        const value = line.match(new RegExp(`^[#ℹ]\\s*${label}\\s+(\\d+)`, "i"));
        if (value) result[key] = Number(value[1]);
      }
    }
    const item = line.match(/^(PASS|FAIL)\s+(.+)$/);
    if (item) result.cases.push({ name: item[2], status: item[1] === "PASS" ? "passed" : "failed", kind: "suite" });
  }
  return reportedTestResults(result);
}
