import { type LabelHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

// Accessible form labels (Phase 6 §23).
export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn("text-sm font-medium leading-none", className)}
      {...props}
    />
  );
}
