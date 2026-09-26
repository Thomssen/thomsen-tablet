import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { XIcon } from "@/components/icons";
import { Button } from "./Button";
import "./Modal.css";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: number;
}

export function Modal({ open, onClose, title, description, children, footer, width = 460 }: ModalProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  // Callers typically pass an inline `onClose`, a fresh function reference on
  // every render of THEIR component - e.g. every keystroke into a controlled
  // field inside this modal. Reading it via a ref (always current, but never
  // itself a dependency) keeps the effect below from re-running on every one
  // of those renders, which previously re-triggered the auto-focus timeout
  // below on every keystroke.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    const prevFocus = document.activeElement as HTMLElement | null;
    const t = window.setTimeout(() => {
      // Body fields (the actual form) come before the footer's action
      // buttons in DOM order, so this naturally prefers a field to type into
      // over a button - and never the header's close button, which isn't a
      // sensible thing to land focus on when a dialog opens.
      cardRef.current?.querySelector<HTMLElement>(".modal__body input, .modal__body textarea, .modal__body select, .modal__footer button")?.focus();
    }, 30);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.clearTimeout(t);
      prevFocus?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div className="modal is-in" role="presentation" onMouseDown={onClose}>
      <div className="modal__backdrop" />
      <div
        ref={cardRef}
        className="modal__card"
        style={{ width: `min(${width}px, calc(100vw - 40px))` }}
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal__head">
          <div>
            <h2 className="modal__title">{title}</h2>
            {description && <p className="modal__description">{description}</p>}
          </div>
          <button type="button" className="modal__x" onClick={onClose} aria-label="Close">
            <XIcon size={16} />
          </button>
        </div>
        {children && <div className="modal__body">{children}</div>}
        {footer && <div className="modal__footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
}

export function ConfirmDialog({ open, onClose, onConfirm, title, message, confirmLabel = "Confirm", danger, busy }: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      width={420}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant={danger ? "danger" : "primary"} onClick={onConfirm} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="modal__message">{message}</p>
    </Modal>
  );
}
