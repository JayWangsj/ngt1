import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import styles from "./button.module.css";

const variants = cva(clsx(styles.button, "button"), {
  variants: {
    variant: {
      default: clsx(styles.primary, "button-primary"),
      outline: clsx(styles.outline, "button-outline"),
      cancel: clsx(styles.cancel, "button-cancel"),
      secondary: clsx(styles.secondary, "button-secondary"),
      tertiary: clsx(styles.tertiary, "button-tertiary"),
      ghost: clsx(styles.ghost, "button-ghost"),
      danger: clsx(styles.danger, "button-danger"),
    },
  },
  defaultVariants: { variant: "default" },
});
export function Button({
  className,
  variant,
  asChild = false,
  type,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof variants> & { asChild?: boolean }) {
  const Component = asChild ? Slot : "button";
  return (
    <Component
      className={twMerge(clsx(variants({ variant }), className))}
      type={
        asChild
          ? undefined
          : (type ?? (variant === "cancel" ? "button" : undefined))
      }
      {...props}
    />
  );
}
