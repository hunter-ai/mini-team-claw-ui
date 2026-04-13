"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Dictionary } from "@/lib/i18n/dictionary";
import {
  isLazycatPickerSubmitDetail,
  type LazycatPickerSubmitDetail,
} from "@/lib/lazycat-attachments";

type LazycatFilePickerBridgeProps = {
  messages: Dictionary;
  open: boolean;
  onClose: () => void;
  onSubmit: (detail: LazycatPickerSubmitDetail) => void | Promise<void>;
  onAvailabilityChange: (available: boolean) => void;
  onError: (message: string) => void;
};

export function LazycatFilePickerBridge({
  messages,
  open,
  onClose,
  onSubmit,
  onAvailabilityChange,
  onError,
}: LazycatFilePickerBridgeProps) {
  const elementRef = useRef<HTMLElement | null>(null);
  const onAvailabilityChangeRef = useRef(onAvailabilityChange);
  const onErrorRef = useRef(onError);
  const onCloseRef = useRef(onClose);
  const onSubmitRef = useRef(onSubmit);
  const [ready, setReady] = useState(false);

  onAvailabilityChangeRef.current = onAvailabilityChange;
  onErrorRef.current = onError;
  onCloseRef.current = onClose;
  onSubmitRef.current = onSubmit;

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      if (typeof window === "undefined") {
        return;
      }

      try {
        if (!customElements.get("lzc-file-picker")) {
          await import("@lazycatcloud/lzc-file-pickers");
        }

        const { lzcAPIGateway } = await import("@lazycatcloud/sdk");
        const gateway = new lzcAPIGateway("/_lzc/runtime/grpc/");
        await gateway.box.QueryInfo({});

        if (cancelled) {
          return;
        }

        setReady(true);
        onAvailabilityChangeRef.current(true);
      } catch {
        if (cancelled) {
          return;
        }

        setReady(false);
        onAvailabilityChangeRef.current(false);
        onErrorRef.current(messages.chat.lazycatUnavailable);
      }
    }

    void bootstrap();

    return () => {
      cancelled = true;
    };
  }, [messages.chat.lazycatUnavailable]);

  useEffect(() => {
    const element = elementRef.current;
    if (!element || !open || !ready) {
      return;
    }

    const handleSubmit = async (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (!isLazycatPickerSubmitDetail(detail)) {
        onErrorRef.current(messages.chat.lazycatEmptySelection);
        onCloseRef.current();
        return;
      }

      await onSubmitRef.current(detail);
      onCloseRef.current();
    };

    const handleClose = () => {
      onCloseRef.current();
    };

    element.addEventListener("submit", handleSubmit);
    element.addEventListener("close", handleClose);

    return () => {
      element.removeEventListener("submit", handleSubmit);
      element.removeEventListener("close", handleClose);
    };
  }, [messages.chat.lazycatEmptySelection, open, ready]);

  const picker = useMemo(() => {
    if (!open || !ready) {
      return null;
    }

    return (
      <lzc-file-picker
        ref={elementRef}
        type="file"
        title={messages.chat.lazycatPickerTitle}
        confirm-button-title={messages.chat.lazycatPickerConfirm}
        multiple={true}
        is-modal={true}
        choice-file-only={true}
      />
    );
  }, [messages.chat.lazycatPickerConfirm, messages.chat.lazycatPickerTitle, open, ready]);

  if (!open || !ready) {
    return null;
  }

  return (
    <div className="ui-overlay fixed inset-0 z-50 flex items-center justify-center px-4 py-6">
      <div className="ui-card relative z-10 flex h-[min(46rem,88vh)] w-full max-w-5xl flex-col overflow-hidden rounded-[1rem] p-0">
        <div className="min-h-0 flex-1 bg-white">
          {picker}
        </div>
      </div>
    </div>
  );
}
