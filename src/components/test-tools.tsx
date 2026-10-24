"use client";

import { Database, Play, RotateCcw, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { generateTestDataAction } from "@/app/actions";
import {
  defaultOrderMotionSettings,
  readOrderMotionSettings,
  resetOrderMotionSettings,
  writeOrderMotionSettings,
  type OrderMotionSettings,
} from "@/lib/order-motion";
import { useMessages } from "./language";
import { SimpleSelect } from "./business-select";
import { Button } from "./ui/button";
import settingsCardStyles from "./settings-card.module.css";

type MotionKey = keyof OrderMotionSettings;

const motionControls: {
  key: MotionKey;
  minimum: number;
  maximum: number;
  step: number;
  unit: "px" | "ms" | "%";
}[] = [
  { key: "lift", minimum: 8, maximum: 40, step: 1, unit: "px" },
  { key: "rise", minimum: 80, maximum: 800, step: 10, unit: "ms" },
  { key: "hold", minimum: 0, maximum: 500, step: 10, unit: "ms" },
  { key: "glide", minimum: 200, maximum: 1200, step: 20, unit: "ms" },
  { key: "land", minimum: 80, maximum: 400, step: 10, unit: "ms" },
  { key: "shadowY", minimum: 4, maximum: 30, step: 1, unit: "px" },
  { key: "shadowBlur", minimum: 6, maximum: 40, step: 1, unit: "px" },
  { key: "shadowSpread", minimum: -20, maximum: 0, step: 1, unit: "px" },
  { key: "shadowOpacity", minimum: 10, maximum: 70, step: 1, unit: "%" },
];

export function TestTools() {
  const it = useMessages();
  const router = useRouter();
  const [count, setCount] = useState<"10" | "50" | "100">("10");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [motion, setMotion] = useState(defaultOrderMotionSettings);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() =>
      setMotion(readOrderMotionSettings()),
    );
    return () => window.cancelAnimationFrame(frame);
  }, []);

  function updateMotion(key: MotionKey, value: number) {
    const next = { ...motion, [key]: value };
    setMotion(next);
    writeOrderMotionSettings(next);
  }

  function restoreMotion() {
    resetOrderMotionSettings();
    setMotion(defaultOrderMotionSettings);
  }

  async function generate() {
    setPending(true);
    setMessage("");
    setError("");
    const result = await generateTestDataAction(Number(count) as 10 | 50 | 100);
    setPending(false);
    if (!result.ok) return setError(result.error);
    if (!result.data) return setError(it.connectionError);
    setMessage(
      it.testDataCreated
        .replace("{customers}", String(result.data.customers))
        .replace("{products}", String(result.data.products))
        .replace("{priceRules}", String(result.data.priceRules))
        .replace("{orders}", String(result.data.orders))
        .replace("{quickServices}", String(result.data.quickServices))
        .replace("{retailSales}", String(result.data.retailSales)),
    );
    router.refresh();
  }

  const total = motion.rise + motion.hold + motion.glide + motion.land;

  return (
    <section
      className={`panel padded settings-card ${settingsCardStyles.card} test-tools-settings`}
    >
      <div className={`settings-card-title ${settingsCardStyles.title}`}>
        <Database size={19} aria-hidden="true" />
        <h2>{it.testTools}</h2>
        <span className="test-tools-badge">ngt_test</span>
      </div>
      <p>{it.testToolsHelp}</p>
      <div className="test-data-generator">
        <div>
          <strong>{it.generateTestData}</strong>
          <p>{it.generateTestDataHelp}</p>
        </div>
        <SimpleSelect
          value={count}
          onChange={(value) =>
            setCount(value === "100" ? "100" : value === "50" ? "50" : "10")
          }
          ariaLabel={it.testDataSize}
          placeholder={`10 ${it.testOrders}`}
          options={[
            { value: "10", label: `10 ${it.testOrders}` },
            { value: "50", label: `50 ${it.testOrders}` },
            { value: "100", label: `100 ${it.testOrders}` },
          ]}
        />
        <Button
          type="button"
          disabled={pending}
          onClick={() => void generate()}
        >
          <Sparkles size={17} aria-hidden="true" />
          {pending ? it.generatingTestData : it.generateTestData}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => router.push("/orders")}
        >
          <Play size={17} aria-hidden="true" />
          {it.openRepairList}
        </Button>
      </div>
      {message && (
        <p className="message success" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="message error" role="alert">
          {error}
        </p>
      )}
      <div className="test-motion-heading">
        <div>
          <strong>{it.repairMotionTuning}</strong>
          <p>{it.repairMotionTuningHelp}</p>
        </div>
        <div className="test-motion-total">
          <span>{it.totalDuration}</span>
          <strong>{total} ms</strong>
        </div>
        <Button type="button" variant="outline" onClick={restoreMotion}>
          <RotateCcw size={16} aria-hidden="true" />
          {it.restoreDefaults}
        </Button>
      </div>
      <div className="test-motion-grid">
        {motionControls.map((control) => (
          <label key={control.key} className="test-motion-control">
            <span>
              {it.orderMotion[control.key]}
              <output>
                {motion[control.key]} {control.unit}
              </output>
            </span>
            <input
              type="range"
              min={control.minimum}
              max={control.maximum}
              step={control.step}
              value={motion[control.key]}
              onChange={(event) =>
                updateMotion(control.key, Number(event.target.value))
              }
            />
          </label>
        ))}
      </div>
    </section>
  );
}
