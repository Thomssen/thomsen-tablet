import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, CheckIcon } from "@/components/icons";
import "./Dropdown.css";

export interface DropdownOption<T extends string | number> {
  value: T;
  label: ReactNode;
}

interface DropdownProps<T extends string | number> {
  value: T;
  options: DropdownOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  "aria-label"?: string;
}

/** A themeable stand-in for `<select>`. Native `<select>` popups are drawn by
 * the OS/WebView chrome and can't be restyled to match the app's dark theme
 * (the light system dropdown was the actual "ugly" complaint) - this renders
 * its own popover instead, positioned from the trigger's real screen
 * position via a portal so it's never clipped by a scrolling ancestor. */
export function Dropdown<T extends string | number>({ value, options, onChange, disabled, "aria-label": ariaLabel }: DropdownProps<T>) {
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const [rect, setRect] = useState<{ top: number; left: number; width: number; openUpward: boolean } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);

  const selectedIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );

  const close = () => setOpen(false);

  const openMenu = () => {
    if (disabled || options.length === 0) return;
    const trigger = triggerRef.current;
    if (trigger) {
      const r = trigger.getBoundingClientRect();
      const estimatedHeight = Math.min(options.length * 34 + 8, 260);
      const openUpward = r.bottom + estimatedHeight > window.innerHeight && r.top > estimatedHeight;
      setRect({ top: openUpward ? r.top : r.bottom, left: r.left, width: r.width, openUpward });
    }
    setHighlighted(selectedIndex);
    setOpen(true);
  };

  // Re-measure once the real menu has a height, in case the estimate above
  // (used before it exists) was off enough to still clip at the edge.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !menuRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    const menuHeight = menuRef.current.offsetHeight;
    const openUpward = r.bottom + menuHeight > window.innerHeight && r.top > menuHeight;
    setRect({ top: openUpward ? r.top : r.bottom, left: r.left, width: r.width, openUpward });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlighted((h) => Math.min(h + 1, options.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlighted((h) => Math.max(h - 1, 0));
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        const opt = options[highlighted];
        if (opt) onChange(opt.value);
        close();
      }
    };
    const onScroll = (e: Event) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      close();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [open, highlighted, options, onChange]);

  const selected = options[selectedIndex];

  return (
    <div className="dropdown">
      <button
        ref={triggerRef}
        type="button"
        className="dropdown__trigger input"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => (open ? close() : openMenu())}
      >
        <span className="dropdown__value">{selected?.label ?? ""}</span>
        <ChevronDown className={["dropdown__chevron", open ? "is-open" : ""].filter(Boolean).join(" ")} size={15} />
      </button>

      {open &&
        rect &&
        createPortal(
          <>
            <div className="dropdown__catcher" onMouseDown={close} />
            <ul
              ref={menuRef}
              className={["dropdown__menu", rect.openUpward ? "dropdown__menu--up" : ""].filter(Boolean).join(" ")}
              role="listbox"
              aria-label={ariaLabel}
              style={{
                left: rect.left,
                width: rect.width,
                ...(rect.openUpward ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.top + 6 }),
              }}
            >
              {options.map((o, i) => (
                <li key={o.value} role="presentation">
                  <button
                    type="button"
                    role="option"
                    aria-selected={o.value === value}
                    className={["dropdown__option", o.value === value ? "is-active" : "", i === highlighted ? "is-highlighted" : ""]
                      .filter(Boolean)
                      .join(" ")}
                    onMouseEnter={() => setHighlighted(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      onChange(o.value);
                      close();
                    }}
                  >
                    <span className="dropdown__option-label">{o.label}</span>
                    {o.value === value && <CheckIcon size={14} className="dropdown__check" />}
                  </button>
                </li>
              ))}
            </ul>
          </>,
          document.body,
        )}
    </div>
  );
}
