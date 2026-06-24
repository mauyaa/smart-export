"use client";

import { useState } from "react";
import { checkFertilizer, CheckResult, NotFoundError } from "@/lib/api";
import LabelUploader from "./components/LabelUploader";
import CropSelector from "./components/CropSelector";
import ResultCard from "./components/ResultCard";
import EscalateForm from "./components/EscalateForm";
import { toast } from "sonner";

type AppState = "idle" | "loading" | "result" | "notfound";

export default function Home() {
  const [appState, setAppState] = useState<AppState>("idle");
  const [productName, setProductName] = useState("");
  const [cropName, setCropName] = useState("");
  const [result, setResult] = useState<CheckResult | null>(null);

  async function handleCheck(name: string) {
    if (!cropName) {
      toast.error("Please select a crop first.");
      return;
    }

    setProductName(name);
    setAppState("loading");
    setResult(null);

    try {
      const data = await checkFertilizer(name, cropName);
      setResult(data);
      setAppState("result");
    } catch (err: any) {
      if (err instanceof NotFoundError) {
        setAppState("notfound");
      } else {
        toast.error(err.message || "Something went wrong. Please try again.");
        setAppState("idle");
      }
    }
  }

  function handleReset() {
    setAppState("idle");
    setResult(null);
    setProductName("");
  }

  return (
    <main className="min-h-screen bg-[#F7F3EC]">
      {/* Header */}
      <header className="bg-[#1A3D2B] text-white py-5 px-6 shadow-sm">
        <div className="max-w-lg mx-auto">
          <h1 className="text-xl font-bold tracking-tight">SmartExports</h1>
          <p className="text-sm text-green-200 mt-0.5">
            EU compliance checker for Kenyan farmers
          </p>
        </div>
      </header>

      <div className="max-w-lg mx-auto px-4 py-8 space-y-6">
        {/* Intro */}
        {appState === "idle" && (
          <div className="space-y-1">
            <h2 className="text-lg font-semibold text-[#1A3D2B]">
              Is this fertilizer safe to use?
            </h2>
            <p className="text-sm text-gray-500">
              Check if a fertilizer or input could put your EU export eligibility
              at risk before you apply it.
            </p>
          </div>
        )}

        {/* Input section — always visible unless result or notfound */}
        {(appState === "idle" || appState === "loading") && (
          <div className="bg-white rounded-xl shadow-sm p-5 space-y-5">
            <CropSelector
              value={cropName}
              onChange={setCropName}
              disabled={appState === "loading"}
            />
            <LabelUploader
              onExtracted={handleCheck}
              isLoading={appState === "loading"}
            />
          </div>
        )}

        {/* Result */}
        {appState === "result" && result && (
          <div className="space-y-4">
            <ResultCard result={result} />
            <button
              onClick={handleReset}
              className="w-full text-sm text-gray-500 hover:text-[#1A3D2B] underline underline-offset-2 transition-colors"
            >
              Check another product
            </button>
          </div>
        )}

        {/* Not found — escalate */}
        {appState === "notfound" && (
          <EscalateForm
            fertilizerName={productName}
            cropName={cropName}
            onDone={handleReset}
          />
        )}
      </div>
    </main>
  );
}
