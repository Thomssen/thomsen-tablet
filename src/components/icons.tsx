/**
 * The only icons in the app: window controls and a small set of functional
 * glyphs (never decorative). All 1em, currentColor, 1.6 stroke - quiet.
 */

type P = { className?: string; size?: number };

const svg = (size: number, children: React.ReactNode, extra?: string) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    className={extra}
  >
    {children}
  </svg>
);

export const MinimizeIcon = ({ size = 12 }: P) => svg(size, <path d="M5 12h14" />);
export const MaximizeIcon = ({ size = 12 }: P) => svg(size, <rect x="5" y="5" width="14" height="14" rx="1.5" />);
export const RestoreIcon = ({ size = 12 }: P) =>
  svg(
    size,
    <>
      <rect x="7.5" y="7.5" width="11" height="11" rx="1.5" />
      <path d="M5.5 14.5V6a1.5 1.5 0 0 1 1.5-1.5h8.5" />
    </>,
  );
export const CloseIcon = ({ size = 12 }: P) => svg(size, <path d="M6 6l12 12M18 6L6 18" />);

export const ChevronDown = ({ className, size = 16 }: P) => svg(size, <path d="M6 9l6 6 6-6" />, className);
export const CheckIcon = ({ className, size = 16 }: P) => svg(size, <path d="M20 6L9 17l-5-5" />, className);
export const XIcon = ({ className, size = 16 }: P) => svg(size, <path d="M6 6l12 12M18 6L6 18" />, className);
export const CopyIcon = ({ className, size = 15 }: P) =>
  svg(
    size,
    <>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" />
    </>,
    className,
  );
