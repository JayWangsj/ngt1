import Image from "next/image";

type BrandLogoProps = {
  className?: string;
  priority?: boolean;
  variant?: "horizontal" | "mark" | "app-icon";
};

const variants = {
  horizontal: {
    src: "/brand/ngt-logo-horizontal.svg",
    width: 632,
    height: 238,
  },
  mark: {
    src: "/brand/ngt-phone-mark-source.png",
    width: 149,
    height: 235,
  },
  "app-icon": {
    src: "/brand/ngt-app-icon.png",
    width: 194,
    height: 194,
  },
} as const;

export function BrandLogo({
  className,
  priority = false,
  variant = "horizontal",
}: BrandLogoProps) {
  const asset = variants[variant];
  return (
    <Image
      alt={variant === "horizontal" ? "NGT NEXT GEN TECH" : "NGT"}
      className={className}
      height={asset.height}
      priority={priority}
      src={asset.src}
      width={asset.width}
    />
  );
}
