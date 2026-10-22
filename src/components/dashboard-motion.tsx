"use client";

import { useRouter } from "next/navigation";
import {
  useEffect,
  useRef,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from "react";
import { prefersReducedMotion } from "@/lib/motion-preference";

export function DashboardMotion({
  fingerprint,
  locale,
  children,
}: {
  fingerprint: string;
  locale: "it" | "zh";
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const navigationTimer = useRef<ReturnType<typeof setTimeout>>(null);
  const router = useRouter();

  function navigateToDay(day: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
    if (navigationTimer.current) clearTimeout(navigationTimer.current);
    const navigate = () => router.push(`/?day=${encodeURIComponent(day)}`);
    if (prefersReducedMotion()) {
      navigate();
      return;
    }
    root.current?.classList.add("dashboard-updating");
    navigationTimer.current = setTimeout(navigate, 120);
  }

  function handleSubmit(event: FormEvent<HTMLDivElement>) {
    const form = event.target as HTMLFormElement;
    if (!form.matches(".dashboard-date-filter")) return;
    event.preventDefault();
    navigateToDay(String(new FormData(form).get("day") ?? ""));
  }

  function handleChange(event: ChangeEvent<HTMLDivElement>) {
    const input = event.target as HTMLInputElement;
    if (!input.matches('.dashboard-date-filter input[type="date"]')) return;
    navigateToDay(input.value);
  }

  useEffect(
    () => () => {
      if (navigationTimer.current) clearTimeout(navigationTimer.current);
    },
    [],
  );

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    element.classList.remove(
      "dashboard-animating",
      "dashboard-running",
      "dashboard-updating",
    );
    if (prefersReducedMotion()) return;
    element.classList.add("dashboard-animating");
    const counts = Array.from(
      element.querySelectorAll<HTMLElement>("[data-count]"),
    );
    const bars = Array.from(
      element.querySelectorAll<HTMLElement>("[data-bar]"),
    );
    const donutSegments = Array.from(
      element.querySelectorAll<SVGCircleElement>("[data-donut-segment]"),
    );
    const moneyFormat = new Intl.NumberFormat(
      locale === "zh" ? "zh-CN" : "it-IT",
      { style: "currency", currency: "EUR" },
    );
    const integerFormat = new Intl.NumberFormat(
      locale === "zh" ? "zh-CN" : "it-IT",
    );

    counts.forEach((node) => {
      node.textContent =
        node.dataset.countType === "money" ? moneyFormat.format(0) : "0";
    });
    bars.forEach((node) => (node.style.transform = "scaleY(0)"));
    donutSegments.forEach((node) => {
      node.style.strokeDasharray = "0 100";
      node.style.strokeDashoffset = node.dataset.donutOffset ?? "0";
    });
    void element.offsetHeight;

    let frame = 0;
    const start = performance.now();
    const animationDuration = 1150;
    const progressAt = (elapsed: number, delay: number, duration: number) => {
      const raw = Math.max(0, Math.min(1, (elapsed - delay) / duration));
      return 1 - Math.pow(1 - raw, 3);
    };
    const animate = (now: number) => {
      const elapsed = now - start;
      const countProgress = progressAt(elapsed, 70, 800);
      counts.forEach((node) => {
        const target = Number(node.dataset.count ?? 0);
        const value = Math.round(target * countProgress);
        node.textContent =
          node.dataset.countType === "money"
            ? moneyFormat.format(value / 100)
            : integerFormat.format(value);
      });
      bars.forEach((node, index) => {
        const barProgress = progressAt(elapsed, 180 + (index % 3) * 45, 850);
        node.style.transform = `scaleY(${barProgress})`;
      });
      donutSegments.forEach((node, index) => {
        const target = Number(node.dataset.donutSegment ?? 0);
        const donutProgress = progressAt(elapsed, 260 + index * 60, 800);
        const value = target * donutProgress;
        node.style.strokeDasharray = `${value} ${100 - value}`;
      });
      if (elapsed < animationDuration) frame = requestAnimationFrame(animate);
      else {
        element.classList.remove("dashboard-animating");
      }
    };
    const reveal = requestAnimationFrame(() => {
      element.classList.add("dashboard-running");
      frame = requestAnimationFrame(animate);
    });
    return () => {
      cancelAnimationFrame(reveal);
      cancelAnimationFrame(frame);
      element.classList.remove("dashboard-animating", "dashboard-running");
    };
  }, [fingerprint, locale]);

  return (
    <div
      ref={root}
      className="dashboard-animating"
      data-testid="dashboard-motion"
      onChange={handleChange}
      onSubmit={handleSubmit}
    >
      {children}
    </div>
  );
}
