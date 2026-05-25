"use client";

import { useEffect, useRef, useState } from "react";
import { Wand2 } from "lucide-react";
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
    if (open) textareaRef.current?.focus();
  }, [open]);

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
      onResult(text);
      setInstruction("");
      setOpen(false);
    } catch {
      setError("Failed to generate. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleGenerate();
    }
    if (e.key === "Escape") {
      setOpen(false);
    }
  }

  const panelWidth = size === "sm" ? "w-64" : "w-80";

  return (
    <div className={`relative ${className ?? ""}`} ref={panelRef}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
          setError("");
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
          className={`absolute right-0 top-full z-[200] mt-1.5 ${panelWidth} rounded-xl border border-gray-100 bg-white p-3 shadow-lg`}
          onClick={(e) => e.stopPropagation()}
        >
          <p className="mb-2 text-xs font-medium text-gray-700">Writing Assistant</p>
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
        </div>
      )}
    </div>
  );
}
