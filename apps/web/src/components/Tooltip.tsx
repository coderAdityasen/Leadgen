import { type ReactNode } from "react";

export interface TooltipProps {
  children: ReactNode;
  title?: string;
  limitation?: string;
  position?: "top" | "bottom" | "left" | "right";
  className?: string;
}

export function Tooltip({ children, className = "" }: TooltipProps) {
  if (className) {
    return <span className={className}>{children}</span>;
  }
  return <>{children}</>;
}

export function HelpTip() {
  return null;
}
