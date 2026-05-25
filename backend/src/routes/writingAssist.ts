import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { completeText } from "../lib/llm";
import { getUserModelSettings } from "../lib/userSettings";

export const writingAssistRouter = Router();

const VALID_CONTEXT_TYPES = [
  "workflow_prompt",
  "column_extraction",
  "supplementary_instructions",
] as const;

type ContextType = (typeof VALID_CONTEXT_TYPES)[number];

const SYSTEM_PROMPTS: Record<ContextType, string> = {
  workflow_prompt: [
    "You are an expert legal AI workflow designer.",
    "You help users write clear, detailed workflow prompts that instruct a legal AI assistant.",
    "Use proper legal nomenclature and structure the output with headings and bullet points where appropriate.",
    "Your output must be valid Markdown.",
    'Return only valid JSON with a single field: {"text": "<markdown string>"}.',
    "When refining existing text, preserve the overall structure and intent while applying the user's requested changes.",
    "When generating from scratch, create a comprehensive workflow prompt suitable for legal document analysis.",
  ].join(" "),

  column_extraction: [
    "You are an expert at writing extraction prompts for legal tabular review columns.",
    "Each prompt instructs an AI to extract specific information from legal documents.",
    "The prompt must focus solely on WHAT to extract — never on formatting, response structure, or output format (that is handled separately).",
    'Return only valid JSON with a single field: {"text": "<prompt string>"}.',
    "Use precise legal terminology.",
    "The prompt should be specific enough to produce consistent results across diverse legal documents.",
  ].join(" "),

  supplementary_instructions: [
    "You are a legal AI assistant helping a user compose supplementary instructions for a workflow.",
    "These are brief additions or clarifications to an existing workflow prompt.",
    "Keep the output concise (1-3 sentences) and focused.",
    'Return only valid JSON with a single field: {"text": "<instruction string>"}.',
  ].join(" "),
};

writingAssistRouter.post("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { context_type, current_text, user_instruction, metadata } = req.body;

  if (!context_type || !VALID_CONTEXT_TYPES.includes(context_type as ContextType)) {
    return void res.status(400).json({
      detail: `Invalid context_type. Must be one of: ${VALID_CONTEXT_TYPES.join(", ")}`,
    });
  }

  if (typeof user_instruction !== "string" || !user_instruction.trim()) {
    return void res.status(400).json({ detail: "user_instruction is required" });
  }

  const parts: string[] = [];

  if (metadata?.workflow_title) {
    parts.push(`Workflow title: ${metadata.workflow_title}`);
  }
  if (metadata?.column_name) {
    parts.push(`Column name: ${metadata.column_name}`);
  }
  if (metadata?.column_format) {
    parts.push(`Expected format: ${metadata.column_format}`);
  }
  if (metadata?.column_tags?.length) {
    parts.push(`Available tags: ${metadata.column_tags.join(", ")}`);
  }

  if (typeof current_text === "string" && current_text.trim()) {
    parts.push(`\nCurrent text:\n${current_text.slice(0, 4096)}`);
  }

  parts.push(`\nUser instruction: ${user_instruction.slice(0, 512)}`);

  const userMessage = parts.join("\n");
  const systemPrompt = SYSTEM_PROMPTS[context_type as ContextType];

  const { title_model, api_keys } = await getUserModelSettings(userId);

  const fallbackModels = [
    title_model,
    ...(api_keys.openai?.trim() ? ["gpt-5.4-nano"] : []),
    ...(api_keys.claude?.trim() ? ["claude-haiku-4-5"] : []),
    ...(api_keys.gemini?.trim() ? ["gemini-3.1-flash-lite-preview"] : []),
  ];
  const uniqueModels = [...new Set(fallbackModels)];

  let lastError: unknown;
  for (const model of uniqueModels) {
    try {
      const raw = await completeText({
        model,
        systemPrompt,
        user: userMessage,
        maxTokens: 1024,
        apiKeys: api_keys,
      });

      const parsed = JSON.parse(
        raw
          .replace(/^```(?:json)?\n?/i, "")
          .replace(/\n?```$/, "")
          .trim(),
      ) as { text?: unknown };

      if (typeof parsed.text === "string" && parsed.text.trim()) {
        return void res.json({ text: parsed.text.trim() });
      }
    } catch (err) {
      lastError = err;
    }
  }

  res.status(502).json({
    detail: "Writing assistant failed to generate text",
  });
});
