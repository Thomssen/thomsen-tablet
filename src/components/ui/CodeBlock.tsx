import { useMemo, useState } from "react";
import { CopyButton } from "./CopyButton";
import "./CodeBlock.css";

interface CodeBlockProps {
  text: string;
  /** Shown top-left, e.g. "json", "raw", "log". */
  label?: string;
  /** Max viewport height before scrolling. */
  maxHeight?: number;
}

export function CodeBlock({ text, label, maxHeight = 420 }: CodeBlockProps) {
  const [wrap, setWrap] = useState(false);
  const lineCount = useMemo(() => (text ? text.split("\n").length : 0), [text]);

  return (
    <div className="codeblock">
      <div className="codeblock__bar">
        {label && <span className="codeblock__label">{label}</span>}
        <span className="codeblock__meta">
          {lineCount} {lineCount === 1 ? "line" : "lines"} · {text.length} chars
        </span>
        <div className="codeblock__actions">
          <button type="button" className={["codeblock__toggle", wrap ? "is-on" : ""].filter(Boolean).join(" ")} onClick={() => setWrap((w) => !w)}>
            Wrap
          </button>
          <CopyButton value={text} />
        </div>
      </div>
      <pre className={["codeblock__pre", "selectable", wrap ? "codeblock__pre--wrap" : ""].filter(Boolean).join(" ")} style={{ maxHeight }}>
        <code>{text || "(empty)"}</code>
      </pre>
    </div>
  );
}
