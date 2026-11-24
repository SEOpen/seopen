import { cva, type VariantProps } from "class-variance-authority";
import Link from "next/link";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 rounded-md whitespace-nowrap transition-colors duration-[120ms] ease-instrument disabled:pointer-events-none disabled:bg-surface disabled:text-disabled focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent",
  {
    variants: {
      variant: {
        primary: "bg-accent-fill font-semibold text-accent-fg hover:bg-accent-hover",
        secondary: "border border-control-edge font-medium text-fg hover:bg-surface-2",
        ghost: "font-medium text-secondary hover:bg-surface-2 hover:text-fg",
        danger: "border border-control-edge font-medium text-bad hover:bg-bad/8",
      },
      size: {
        sm: "h-[30px] px-3 text-[13px]",
        md: "h-[38px] px-4 text-sm",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

type Variants = VariantProps<typeof buttonVariants>;

export function Button({ className, variant, size, ...props }: ComponentProps<"button"> & Variants) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export function ButtonLink({ className, variant, size, ...props }: ComponentProps<typeof Link> & Variants) {
  return <Link className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
