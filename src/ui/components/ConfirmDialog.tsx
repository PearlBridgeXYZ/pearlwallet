import { useEffect, useRef, type ReactNode } from 'react';

/** Native modal supplies inert background; explicitly cycle keyboard focus. */
export default function ConfirmDialog({children, onCancel, busy = false}: {
  children: ReactNode; onCancel: () => void; busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current!;
    dialog.showModal();
    dialog.querySelector<HTMLButtonElement>('button')?.focus();
    return () => { dialog.close(); previous?.focus(); };
  }, []);
  useEffect(() => {
    // Disabling the focused button moves focus to BODY in Chromium.
    // Keep keyboard and screen-reader context inside the busy modal.
    if (busy && ref.current?.open) ref.current.focus();
  }, [busy]);
  return <dialog ref={ref} tabIndex={-1} aria-labelledby="replace-wallet-title"
    className="m-auto max-w-md max-h-[90dvh] overflow-y-auto bg-transparent p-4 text-text-1 backdrop:bg-black/40"
    onKeyDown={e=>{
      if(e.key !== 'Tab') return;
      const elements = Array.from(ref.current!.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), a[href], select:not([disabled]), textarea:not([disabled]), [tabindex="0"]'
      )).filter(el=>el.getClientRects().length > 0);
      const first=elements[0], last=elements[elements.length-1];
      if(!first){e.preventDefault();ref.current?.focus();return;}
      if(e.shiftKey && (document.activeElement===first || document.activeElement===ref.current)){
        e.preventDefault();last.focus();
      }else if(!e.shiftKey && document.activeElement===last){e.preventDefault();first.focus();}
    }}
    onCancel={e=>{e.preventDefault();if(!busy)onCancel();}}>{children}</dialog>;
}
