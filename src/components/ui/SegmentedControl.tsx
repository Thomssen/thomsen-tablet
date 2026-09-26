import "./SegmentedControl.css";

interface Option<T extends string> {
  value: T;
  label: string;
}

interface SegmentedControlProps<T extends string> {
  options: readonly Option<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: "sm" | "md";
  "aria-label"?: string;
}

export function SegmentedControl<T extends string>({ options, value, onChange, size = "md", ...rest }: SegmentedControlProps<T>) {
  return (
    <div className={`segmented segmented--${size}`} role="tablist" aria-label={rest["aria-label"]}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="tab"
          aria-selected={opt.value === value}
          className={["segmented__item", opt.value === value ? "is-active" : ""].filter(Boolean).join(" ")}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
