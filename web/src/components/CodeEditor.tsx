"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

export type CodeSearchStats = {
  count: number;
  current: number;
  query: string;
};

type CodeEditorProps = {
  value: string;
  fileName?: string;
  runtime?: string;
  search?: string;
  searchIndex?: number;
  searchAction?: number;
  readOnly?: boolean;
  onSearchStats?: (stats: CodeSearchStats) => void;
  onChange: (value: string) => void;
};

type Match = {
  start: number;
  end: number;
  line: number;
};

const LINE_HEIGHT = 24;
const CODE_PADDING_LEFT = 18;
const CODE_PADDING_TOP = 16;
const CARET_LEFT_SHIFT = 1;
const CARET_WIDTH = 2;
const TAB_SIZE = "  ";
const PAIRS: Record<string, string> = {
  "(": ")",
  "[": "]",
  "{": "}",
  "\"": "\"",
  "'": "'",
  "`": "`",
};
const keywords = new Set([
  "abstract", "as", "async", "await", "break", "case", "catch", "class", "const", "continue", "def",
  "else", "enum", "export", "extends", "false", "finally", "for", "from", "function", "if", "implements",
  "import", "in", "interface", "let", "new", "null", "private", "protected", "public", "return", "static",
  "super", "switch", "this", "throw", "true", "try", "type", "undefined", "var", "void", "while", "with",
  "yield", "None", "True", "False", "raise", "except", "using", "namespace", "record",
  "declare", "readonly", "override", "package", "module", "sealed", "final", "foreach", "goto", "lock",
  "operator", "params", "ref", "out", "partial", "synchronized", "volatile", "transient", "native",
  "lambda", "match", "when", "where", "global", "nonlocal", "pass", "del", "awaited", "asyncio",
]);

const builtins = new Set([
  "Deno", "Request", "Response", "JSON", "Math", "URL", "URLSearchParams", "process", "console",
  "Date", "Array", "Object", "String", "Number", "Boolean", "Promise", "Map", "Set", "Guid",
]);

function languageFromRuntime(runtime?: string) {
  if (runtime === "python311") return "python";
  if (runtime === "deno") return "typescript";
  if (runtime === "java-spring") return "java";
  if (runtime === "dotnet8") return "csharp";
  return "javascript";
}

function runtimeLabel(runtime?: string) {
  if (runtime === "python311") return "Python";
  if (runtime === "deno") return "TypeScript";
  if (runtime === "java-spring") return "Java";
  if (runtime === "dotnet8") return "C#";
  if (runtime === "custom") return "Docker";
  return "JavaScript";
}

function lineStartsFor(text: string) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function lineForOffset(starts: number[], offset: number) {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (starts[mid] <= offset && (mid === starts.length - 1 || starts[mid + 1] > offset)) return mid;
    if (starts[mid] > offset) high = mid - 1;
    else low = mid + 1;
  }
  return 0;
}

function findMatches(text: string, query: string, starts: number[]) {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const haystack = text.toLowerCase();
  const matches: Match[] = [];
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    matches.push({
      start: index,
      end: index + needle.length,
      line: lineForOffset(starts, index),
    });
    index = haystack.indexOf(needle, index + needle.length);
  }
  return matches;
}

function splitSearch(text: string, query: string, className: string) {
  const q = query.trim();
  if (!q) return text;
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const parts = [];
  let cursor = 0;
  let index = lower.indexOf(needle);
  while (index !== -1) {
    if (index > cursor) parts.push(text.slice(cursor, index));
    parts.push(<span key={`${index}-${parts.length}`} className={className}>{text.slice(index, index + q.length)}</span>);
    cursor = index + q.length;
    index = lower.indexOf(needle, cursor);
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts.length ? parts : text;
}

function tokenClass(token: string, previous = "") {
  if (/^\/\/|^#|^\/\*/.test(token)) return "tok-comment";
  if (/^["'`]/.test(token)) return "tok-string";
  if (/^\d/.test(token)) return "tok-number";
  if (keywords.has(token)) return "tok-keyword";
  if (builtins.has(token)) return "tok-builtin";
  if (/^[A-Z_][A-Z0-9_]*$/.test(token)) return "tok-env";
  if (previous === "function" || previous === "def" || previous === "class") return "tok-function";
  if (/^[{}()[\].,;:<>?=+\-*/!|&%]$/.test(token)) return "tok-punctuation";
  return "";
}

function renderHighlightedLine(line: string, query: string) {
  const regex = /(\/\/.*|#.*|\/\*.*?\*\/|"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|`(?:\\.|[^`])*`|\b[A-Za-z_$][\w$]*\b|\b\d+(?:\.\d+)?\b|[{}()[\].,;:<>?=+\-*/!|&%])/g;
  const nodes = [];
  let cursor = 0;
  let previous = "";
  let match: RegExpExecArray | null;

  while ((match = regex.exec(line))) {
    if (match.index > cursor) {
      nodes.push(<span key={`plain-${cursor}`}>{splitSearch(line.slice(cursor, match.index), query, "tok-search")}</span>);
    }
    const token = match[0];
    const cls = tokenClass(token, previous);
    nodes.push(<span key={`${match.index}-${token}`} className={cls}>{splitSearch(token, query, "tok-search")}</span>);
    previous = token;
    cursor = match.index + token.length;
  }

  if (cursor < line.length) {
    nodes.push(<span key={`tail-${cursor}`}>{splitSearch(line.slice(cursor), query, "tok-search")}</span>);
  }

  return nodes.length ? nodes : "\u00a0";
}

function getLineIndent(value: string, offset: number) {
  const lineStart = value.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  const lineEnd = value.indexOf("\n", offset);
  const line = value.slice(lineStart, lineEnd === -1 ? value.length : lineEnd);
  return line.match(/^\s*/)?.[0] || "";
}

function replaceSelection(value: string, start: number, end: number, insertion: string, cursorStart: number, cursorEnd = cursorStart) {
  return {
    value: value.slice(0, start) + insertion + value.slice(end),
    start: cursorStart,
    end: cursorEnd,
  };
}

function nextSelectionForTab(value: string, start: number, end: number, shift: boolean) {
  const indent = TAB_SIZE;
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  const selectionHasLines = value.slice(start, end).includes("\n");

  if (!selectionHasLines) {
    if (shift) {
      const removable = value.slice(lineStart, Math.min(lineStart + indent.length, value.length));
      const removeCount = removable.startsWith(indent) ? indent.length : removable.startsWith(" ") ? 1 : 0;
      if (!removeCount || start < lineStart + removeCount) return null;
      return {
        value: value.slice(0, lineStart) + value.slice(lineStart + removeCount),
        start: start - removeCount,
        end: end - removeCount,
      };
    }
    return {
      value: value.slice(0, start) + indent + value.slice(end),
      start: start + indent.length,
      end: start + indent.length,
    };
  }

  const blockStart = lineStart;
  const blockEnd = end;
  const block = value.slice(blockStart, blockEnd);
  const lines = block.split("\n");

  if (shift) {
    let removed = 0;
    const out = lines.map((line) => {
      if (line.startsWith(indent)) {
        removed += indent.length;
        return line.slice(indent.length);
      }
      if (line.startsWith(" ")) {
        removed += 1;
        return line.slice(1);
      }
      return line;
    });
    return {
      value: value.slice(0, blockStart) + out.join("\n") + value.slice(blockEnd),
      start: Math.max(blockStart, start - Math.min(start - blockStart, indent.length)),
      end: Math.max(blockStart, end - removed),
    };
  }

  const out = lines.map((line) => indent + line);
  return {
    value: value.slice(0, blockStart) + out.join("\n") + value.slice(blockEnd),
    start: start + indent.length,
    end: end + (indent.length * lines.length),
  };
}

export function CodeEditor({
  value,
  fileName,
  runtime,
  search = "",
  searchIndex = 0,
  searchAction = 0,
  readOnly = false,
  onSearchStats,
  onChange,
}: CodeEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const measureRef = useRef<HTMLSpanElement | null>(null);
  const [scroll, setScroll] = useState({ top: 0, left: 0 });
  const [cursor, setCursor] = useState({ line: 0, column: 1 });
  const [hasSelection, setHasSelection] = useState(false);
  const [pendingSelection, setPendingSelection] = useState<{ start: number; end: number } | null>(null);
  const [caretWidth, setCaretWidth] = useState(8);
  const [isFocused, setIsFocused] = useState(false);
  const lines = useMemo(() => value.split("\n"), [value]);
  const lineStarts = useMemo(() => lineStartsFor(value), [value]);
  const matches = useMemo(() => findMatches(value, search, lineStarts), [value, search, lineStarts]);
  const currentMatchIndex = matches.length ? ((searchIndex % matches.length) + matches.length) % matches.length : -1;
  const currentMatch = currentMatchIndex >= 0 ? matches[currentMatchIndex] : null;
  const matchLines = useMemo(() => new Set(matches.map((match) => match.line)), [matches]);
  const language = languageFromRuntime(runtime);
  const updateCursorFromTarget = useCallback((target: HTMLTextAreaElement) => {
    const start = target.selectionStart || 0;
    const end = target.selectionEnd || 0;
    const line = lineForOffset(lineStarts, start);
    const column = start - lineStarts[line] + 1;
    setCursor({ line, column });
    setHasSelection(start !== end);
  }, [lineStarts]);

  useEffect(() => {
    onSearchStats?.({
      count: matches.length,
      current: currentMatchIndex >= 0 ? currentMatchIndex + 1 : 0,
      query: search.trim(),
    });
  }, [matches.length, currentMatchIndex, search, onSearchStats]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || !currentMatch) return;
    textarea.scrollTop = Math.max(0, currentMatch.line * LINE_HEIGHT - 96);
    textarea.setSelectionRange(currentMatch.start, currentMatch.end);
    updateCursorFromTarget(textarea);
    setScroll((current) => ({ ...current, top: textarea.scrollTop }));
    if (searchAction > 0) textarea.focus({ preventScroll: true });
  }, [currentMatch?.start, currentMatch?.end, currentMatch?.line, searchAction, updateCursorFromTarget]);

  useEffect(() => {
    if (!pendingSelection) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.setSelectionRange(pendingSelection.start, pendingSelection.end);
    updateCursorFromTarget(textarea);
    setPendingSelection(null);
  }, [pendingSelection, value, updateCursorFromTarget]);

  useEffect(() => {
    const span = measureRef.current;
    if (!span) return;
    const width = span.getBoundingClientRect().width / 10;
    if (Number.isFinite(width) && width > 0) setCaretWidth(width);
  }, [runtime]);

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (readOnly) return;
    const target = event.currentTarget;
    const start = target.selectionStart || 0;
    const end = target.selectionEnd || 0;

    if (event.key === "Tab") {
      event.preventDefault();
      const next = nextSelectionForTab(value, start, end, event.shiftKey);
      if (!next) return;
      setPendingSelection({ start: next.start, end: next.end });
      onChange(next.value);
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      const indent = getLineIndent(value, start);
      const currentLineStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
      const currentLineEnd = value.indexOf("\n", start);
      const currentLine = value.slice(currentLineStart, currentLineEnd === -1 ? value.length : currentLineEnd).trimEnd();
      const extraIndent = /[\{\[\(:]$/.test(currentLine) ? TAB_SIZE : "";
      const insertion = `\n${indent}${extraIndent}`;
      const next = replaceSelection(value, start, end, insertion, start + insertion.length);
      setPendingSelection({ start: next.start, end: next.end });
      onChange(next.value);
      return;
    }

    if (event.key === "Backspace" && start === end && start > 0 && start < value.length) {
      const prev = value[start - 1];
      const next = value[start];
      const isPair =
        (prev === "(" && next === ")") ||
        (prev === "[" && next === "]") ||
        (prev === "{" && next === "}") ||
        (prev === "\"" && next === "\"") ||
        (prev === "'" && next === "'") ||
        (prev === "`" && next === "`");
      if (isPair) {
        event.preventDefault();
        const nextValue = value.slice(0, start - 1) + value.slice(start + 1);
        setPendingSelection({ start: start - 1, end: start - 1 });
        onChange(nextValue);
        return;
      }
    }

    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const pair = PAIRS[event.key];
      if (pair) {
        event.preventDefault();
        if (start !== end) {
          const selected = value.slice(start, end);
          const insertion = `${event.key}${selected}${pair}`;
          const next = replaceSelection(value, start, end, insertion, start + 1, start + 1 + selected.length);
          setPendingSelection({ start: next.start, end: next.end });
          onChange(next.value);
        } else {
          const insertion = `${event.key}${pair}`;
          const next = replaceSelection(value, start, end, insertion, start + 1);
          setPendingSelection({ start: next.start, end: next.end });
          onChange(next.value);
        }
        return;
      }
    }

    if (start === end && [")", "]", "}", "\"", "'", "`"].includes(event.key)) {
      const nextChar = value[start];
      if (nextChar === event.key) {
        event.preventDefault();
        setPendingSelection({ start: start + 1, end: start + 1 });
        onChange(value);
      }
    }
  }

  const caretX = CODE_PADDING_LEFT + Math.max(0, cursor.column - 1) * caretWidth - scroll.left + CARET_LEFT_SHIFT;
  const caretY = CODE_PADDING_TOP + cursor.line * LINE_HEIGHT - scroll.top;

  return (
    <div className="code-editor-shell">
      <div className="code-editor-titlebar">
        <div className="code-editor-tabs">
          <div className="code-editor-tab is-active">
            <span className="code-editor-file-dot" />
            <span className="truncate">{fileName || "index"}</span>
          </div>
        </div>
        <div className="code-editor-meta">
          <span>{runtimeLabel(runtime)}</span>
          <span>Ln {cursor.line + 1}, Col {cursor.column}</span>
        </div>
      </div>
      <div className="code-editor" data-language={language}>
        <span ref={measureRef} className="code-measure" aria-hidden="true">0000000000</span>
        <div className="code-gutter" aria-hidden="true">
          <div className="code-gutter-inner" style={{ transform: `translateY(${-scroll.top}px)` }}>
            {lines.map((_, index) => (
              <div
                key={index}
                className={[
                  matchLines.has(index) ? "is-match" : "",
                  currentMatch?.line === index ? "is-current" : "",
                  cursor.line === index ? "is-active-line" : "",
                ].filter(Boolean).join(" ")}
              >
                {index + 1}
              </div>
            ))}
          </div>
        </div>
        <div className="code-pane">
          <pre
            className="code-highlight"
            style={{ transform: `translate(${-scroll.left}px, ${-scroll.top}px)` }}
            aria-hidden="true"
          >
            {lines.map((line, index) => (
              <div
                key={index}
                className={[
                  "code-line",
                  matchLines.has(index) ? "is-match" : "",
                  currentMatch?.line === index ? "is-current" : "",
                  cursor.line === index ? "is-active-line" : "",
                ].filter(Boolean).join(" ")}
              >
                {renderHighlightedLine(line, search)}
              </div>
            ))}
          </pre>
          {isFocused && !readOnly && !hasSelection && (
            <div
              className="code-caret"
              style={{
                transform: `translate(${caretX}px, ${caretY}px)`,
                height: `${LINE_HEIGHT}px`,
                width: `${CARET_WIDTH}px`,
              }}
              aria-hidden="true"
            />
          )}
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(event) => {
              if (readOnly) return;
              onChange(event.target.value);
              updateCursorFromTarget(event.target);
            }}
            onClick={(event) => updateCursorFromTarget(event.currentTarget)}
            onKeyUp={(event) => updateCursorFromTarget(event.currentTarget)}
            onSelect={(event) => updateCursorFromTarget(event.currentTarget)}
            onKeyDown={handleKeyDown}
            onScroll={(event) => setScroll({ top: event.currentTarget.scrollTop, left: event.currentTarget.scrollLeft })}
            onFocus={(event) => {
              setIsFocused(true);
              updateCursorFromTarget(event.currentTarget);
            }}
            onBlur={() => {
              setIsFocused(false);
              setHasSelection(false);
            }}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            wrap="off"
            readOnly={readOnly}
            className="code-input"
            aria-label="Editor de codigo"
            aria-readonly={readOnly}
          />
        </div>
      </div>
    </div>
  );
}
