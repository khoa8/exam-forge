/**
 * Untrusted-material filtering for deterministic extraction and validation.
 *
 * Study material is UNTRUSTED DATA. It must never be able to change system
 * behavior: no model sees the text (generation is deterministic and local), and
 * content that looks like instructions to an AI assistant is filtered out of
 * extraction and rejected as candidate evidence, never persisted as grounded
 * study content. Detection results are surfaced honestly to the user.
 */

const INJECTION_PATTERNS: RegExp[] = [
  /(?:ignore|disregard|forget)\s+(?:(?:all|any|the|your)\s+)?(?:previous|prior|above|earlier)\s+instructions?/i,
  /disregard\s+(all|any|the|your|previous|prior|above)/i,
  /forget\s+(all|any|the|your|previous|prior|above)\s+(instructions?|prompts?)/i,
  /reveal(ing)?\s+(your\s+)?(system\s+)?(prompt|instructions|secrets?|api\s*keys?)/i,
  /you\s+are\s+now\s+(a|an|the)\b/i,
  /act\s+as\s+(a|an|the)\s+(different|new)/i,
  /system\s*:\s*/i,
  /<\|(?:im_start|im_end|system|endoftext)\|>/i,
  /\bnew\s+instructions?\s*:/i,
  /\bdeveloper\s+mode\b/i,
];

export interface InjectionScan {
  detected: boolean;
  matches: string[];
}

export function scanForInjection(text: string): InjectionScan {
  const matches: string[] = [];
  for (const re of INJECTION_PATTERNS) {
    const m = re.exec(text);
    if (m) matches.push(m[0].slice(0, 80));
  }
  return { detected: matches.length > 0, matches };
}

/** Sentence-level check used by extraction to avoid quoting instruction-like text. */
export function looksLikeInstruction(text: string): boolean {
  return INJECTION_PATTERNS.some((re) => re.test(text));
}

export function injectionNotice(): string {
  return "Note: the material contains text that looks like instructions to an AI assistant. ExamForge treats study material strictly as data, so those instructions were ignored.";
}
