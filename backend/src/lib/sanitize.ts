const MAX_LLM_INPUT_LEN = 256;

export function sanitizeLlmInput(value: string, maxLen = MAX_LLM_INPUT_LEN): string {
  let clean = value.normalize("NFC");
  clean = clean.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  clean = clean.replace(/[\r\n\t]+/g, " ");
  return clean.slice(0, maxLen).trim();
}
