"use client";

import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { isValidElement } from "react";
import type { ComponentPropsWithoutRef, ReactElement, ReactNode } from "react";
import { PrismAsyncLight as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import type { Dictionary } from "@/lib/i18n/dictionary";
import { enhanceCodeBlock, normalizeCodeBlockInput } from "@/lib/code-block-rendering";

const syntaxTheme = {
  ...oneLight,
  'pre[class*="language-"]': {
    ...(oneLight['pre[class*="language-"]'] ?? {}),
    margin: 0,
    background: "transparent",
  },
  'code[class*="language-"]': {
    ...(oneLight['code[class*="language-"]'] ?? {}),
    background: "transparent",
    fontFamily: "var(--font-mono)",
    fontSize: "0.875rem",
    lineHeight: "1.7",
    textShadow: "none",
  },
  comment: {
    color: "#6b7280",
    fontStyle: "italic",
  },
  keyword: {
    color: "#b45309",
  },
  string: {
    color: "#0f766e",
  },
  function: {
    color: "#1d4ed8",
  },
  number: {
    color: "#7c3aed",
  },
  operator: {
    color: "#334155",
  },
  punctuation: {
    color: "#475569",
  },
};

function CopyIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="size-4.5">
      <rect x="6" y="6" width="9" height="9" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4.5 12.5V5.75A1.25 1.25 0 0 1 5.75 4.5H12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="size-4.5">
      <path d="M5 10.25 8.25 13.5 15 6.75" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

async function copyText(text: string) {
  if (
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard?.writeText === "function" &&
    typeof window !== "undefined" &&
    window.isSecureContext
  ) {
    await navigator.clipboard.writeText(text);
    return;
  }

  if (typeof document === "undefined") {
    throw new Error("Clipboard is unavailable");
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "0";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);

  const selection = document.getSelection();
  const originalRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  const copied = document.execCommand("copy");
  document.body.removeChild(textarea);

  if (selection) {
    selection.removeAllRanges();
    if (originalRange) {
      selection.addRange(originalRange);
    }
  }

  if (!copied) {
    throw new Error("Copy command failed");
  }
}

function getNodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }

  if (Array.isArray(node)) {
    return node.map(getNodeText).join("");
  }

  if (node && typeof node === "object" && "props" in node) {
    return getNodeText((node as { props?: { children?: ReactNode } }).props?.children ?? "");
  }

  return "";
}

function extractCodeBlockData(children: ReactNode) {
  const childArray = Array.isArray(children) ? children : [children];
  const codeChild = childArray.find(
    (child): child is ReactElement<ComponentPropsWithoutRef<"code">> =>
      isValidElement<ComponentPropsWithoutRef<"code">>(child),
  );

  if (!codeChild) {
    return null;
  }

  const className = codeChild.props.className ?? "";
  const languageMatch = className.match(/language-([^\s]+)/);

  return {
    rawCode: getNodeText(codeChild.props.children ?? ""),
    language: languageMatch?.[1] ?? "",
  };
}

function CopyCodeButton({
  text,
  messages,
}: {
  text: string;
  messages: Dictionary;
}) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  return (
    <button
      type="button"
      onClick={async () => {
        if (!text) {
          return;
        }

        try {
          await copyText(text);
          setCopied(true);
          if (timeoutRef.current !== null) {
            window.clearTimeout(timeoutRef.current);
          }

          timeoutRef.current = window.setTimeout(() => {
            setCopied(false);
            timeoutRef.current = null;
          }, 1800);
        } catch {
          setCopied(false);
        }
      }}
      aria-label={copied ? messages.chat.copied : messages.chat.copyCode}
      disabled={!text}
      className={`inline-flex shrink-0 items-center justify-center rounded-full p-1.5 text-[10px] font-medium transition-colors ${
        copied
          ? "text-[#155e75]"
          : "text-[color:var(--text-tertiary)] hover:bg-[rgba(107,114,128,0.16)] hover:text-[color:var(--text-primary)]"
      } ${!text ? "cursor-default opacity-60" : ""}`}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}

export function CodeBlock({
  children,
  messages,
  streaming = false,
  ...props
}: ComponentPropsWithoutRef<"pre"> & { messages: Dictionary; streaming?: boolean }) {
  const data = extractCodeBlockData(children);
  const rawCode = data?.rawCode ?? "";
  const language = data?.language ?? "";
  const normalized = useMemo(
    () => normalizeCodeBlockInput(rawCode, language),
    [language, rawCode],
  );
  const enhancementKey = `${streaming ? "live" : "stable"}:${normalized.language}:${normalized.raw}`;
  const deferredCode = useDeferredValue(normalized.raw);
  const [enhancement, setEnhancement] = useState<{
    key: string;
    displayCode: string;
    copyCode: string;
    highlightLanguage: string | null;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;

    void enhanceCodeBlock({
      raw: deferredCode,
      language: normalized.language,
      stable: !streaming,
    }).then((result) => {
      if (cancelled) {
        return;
      }

      setEnhancement({
        key: enhancementKey,
        displayCode: result.displayCode,
        copyCode: result.copyCode,
        highlightLanguage: result.highlighterLanguage,
      });
    });

    return () => {
      cancelled = true;
    };
  }, [deferredCode, enhancementKey, normalized.language, streaming]);

  if (!data) {
    return <pre {...props}>{children}</pre>;
  }

  const displayCode = enhancement?.key === enhancementKey ? enhancement.displayCode : normalized.raw;
  const copyCode = enhancement?.key === enhancementKey ? enhancement.copyCode : normalized.raw;
  const highlightLanguage = enhancement?.key === enhancementKey
    ? enhancement.highlightLanguage
    : normalized.language || null;

  return (
    <div className="code-block-shell my-3 overflow-hidden rounded-[1rem] border border-[color:var(--border-subtle)] bg-[#f8fafc]">
      <div className="flex items-center justify-between gap-3 px-4 pt-3 pb-0">
        <span className="min-w-0 flex-1 truncate text-[10px] font-semibold uppercase tracking-[0.14em] text-[color:var(--text-tertiary)]">
          {normalized.language || "\u00a0"}
        </span>
        <CopyCodeButton text={copyCode} messages={messages} />
      </div>
      <pre
        {...props}
        className="code-block-shell__pre overflow-x-auto"
      >
        {highlightLanguage ? (
          <SyntaxHighlighter
            language={highlightLanguage}
            style={syntaxTheme}
            PreTag="div"
            CodeTag="code"
            customStyle={{ margin: 0, background: "transparent", padding: 0 }}
            codeTagProps={{ style: { fontFamily: "var(--font-mono)" } }}
            wrapLongLines={false}
          >
            {displayCode}
          </SyntaxHighlighter>
        ) : (
          <code>{displayCode}</code>
        )}
      </pre>
    </div>
  );
}
