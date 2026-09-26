import { useState } from "react";
import { CopyIcon, CheckIcon } from "@/components/icons";
import { copyText } from "@/lib/format";
import "./CopyButton.css";

interface CopyButtonProps {
  value: string;
  label?: string;
  title?: string;
}

export function CopyButton({ value, label, title = "Copy" }: CopyButtonProps) {
  const [done, setDone] = useState(false);

  async function onClick() {
    const ok = await copyText(value);
    if (ok) {
      setDone(true);
      window.setTimeout(() => setDone(false), 1400);
    }
  }

  return (
    <button type="button" className="copy-btn" onClick={onClick} title={title} aria-label={title}>
      {done ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
      {label && <span>{done ? "Copied" : label}</span>}
    </button>
  );
}
