"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Wand2, X } from "lucide-react";
import { writingAssist, type WritingAssistContextType } from "@/app/lib/mikeApi";

interface WritingAssistButtonProps {
  contextType: WritingAssistContextType;
  getCurrentText: () => string;
  onResult: (text: string) => void;
  metadata?: {
    column_name?: string;
    column_format?: string;
    column_tags?: string[];
    workflow_title?: string;
  };
  size?: "sm" | "md";
  className?: string;
}

export function WritingAssistButton({
  contextType,
  getCurrentText,
  onResult,
  metadata,
  size = "md",
  className,
}: WritingAssistButtonProps) {
  const [open, setOpen] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [generatedText, setGeneratedText] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  useEffect(() => {
    if (open && !generatedText) textareaRef.current?.focus();
  }, [open, generatedText]);

  function handleClose() {
    setOpen(false);
    setGeneratedText("");
    setInstruction("");
    setError("");
  }

  async function handleGenerate() {
    if (!instruction.trim() || loading) return;
    setLoading(true);
    setError("");
    try {
      const { text } = await writingAssist({
        context_type: contextType,
        current_text: getCurrentText(),
        user_instruction: instruction.trim(),
        metadata,
      });
      setGeneratedText(text);
    } catch {
      setError("Failed to generate. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  function handleApply() {
    onResult(generatedText);
    handleClose();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleGenerate();
    }
    if (e.key === "Escape") {
      handleClose();
    }
  }

  const panelWidth = size === "sm" ? "w-72" : "w-96";

  return (
    <div className={`relative ${className ?? ""}`} ref={panelRef}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (open) {
            handleClose();
          } else {
            setOpen(true);
            setError("");
            setGeneratedText("");
          }
        }}
        className={`inline-flex items-center gap-1.5 transition-colors ${
          size === "sm"
            ? "text-xs text-gray-600 hover:text-gray-700 disabled:text-gray-300"
            : "text-sm text-gray-500 hover:text-gray-900 disabled:text-gray-300"
        }`}
        title="Writing Assistant"
      >
        <Wand2 className={size === "sm" ? "h-3 w-3" : "h-4 w-4"} />
        {size === "md" && "Writing Assistant"}
      </button>

      {open && (
        <div
          className={`absolute right-0 top-full z-[200] mt-1.5 ${panelWidth} rounded-xl border border-gray-100 bg-white p-4 shadow-lg`}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-medium text-gray-700">Writing Assistant</p>
            <button
              type="button"
              onClick={handleClose}
              className="rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          {!generatedText ? (
            <>
              <textarea
                ref={textareaRef}
                rows={3}
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Describe what you want…"
                disabled={loading}
                className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 placeholder-gray-400 focus:border-gray-400 focus:outline-none resize-none leading-relaxed disabled:opacity-50"
              />
              {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
              <div className="mt-2 flex justify-end">
                <button
                  type="button"
                  onClick={handleGenerate}
                  disabled={!instruction.trim() || loading}
                  className="inline-flex items-center gap-1.5 rounded-full bg-gray-900 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-gray-700 disabled:opacity-40"
                >
                  {loading ? (
                    <span className="h-3 w-3 rounded-full border-2 border-gray-300 border-t-white animate-spin block" />
                  ) : (
                    <Wand2 className="h-3 w-3" />
                  )}
                  Generate
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="max-h-60 overflow-y-auto rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700 leading-relaxed whitespace-pre-wrap">
                {generatedText}
              </div>
              <div className="mt-3 flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => setGeneratedText("")}
                  className="text-xs text-gray-500 hover:text-gray-700 transition-colors"
                >
                  Regenerate
                </button>
                <button
                  type="button"
                  onClick={handleApply}
                  className="inline-flex items-center gap-1.5 rounded-full bg-gray-900 px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-gray-700"
                >
                  <Check className="h-3 w-3" />
                  Apply
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
