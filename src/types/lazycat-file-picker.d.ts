import type * as React from "react";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "lzc-file-picker": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        type?: string;
        title?: string;
        "confirm-button-title"?: string;
        multiple?: boolean;
        "is-modal"?: boolean;
        "choice-file-only"?: boolean;
      };
    }
  }
}
