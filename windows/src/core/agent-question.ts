// SPDX-License-Identifier: MIT
/** Coding-agent questions use their existing relay, independently of chat. */
export interface AgentQuestion {
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
}

export function agentQuestions(value: unknown): AgentQuestion[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) return null;
  const seen = new Set<string>();
  const questions: AgentQuestion[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || typeof item.question !== "string"
      || !item.question.trim() || item.question.length > 2000 || seen.has(item.question)
      || !Array.isArray(item.options) || item.options.length > 8) return null;
    seen.add(item.question);
    const labels = new Set<string>();
    const options: AgentQuestion["options"] = [];
    for (const option of item.options) {
      if (!option || typeof option.label !== "string" || !option.label.trim()
        || option.label.length > 200 || labels.has(option.label)
        || (option.description !== undefined && typeof option.description !== "string")
        || (option.description?.length ?? 0) > 1000) return null;
      labels.add(option.label);
      options.push({label: option.label, description: option.description ?? ""});
    }
    if (item.multiSelect !== undefined && typeof item.multiSelect !== "boolean") return null;
    questions.push({question:item.question,header:typeof item.header === "string" ? item.header : "Question",
      options,multiSelect:item.multiSelect === true});
  }
  return questions;
}
