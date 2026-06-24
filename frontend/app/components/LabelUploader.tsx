"use client";

import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { extractLabel } from "@/lib/api";
import { toast } from "sonner";

interface LabelUploaderProps {
  onExtracted: (productName: string) => void;
  isLoading: boolean;
}

export default function LabelUploader({ onExtracted, isLoading }: LabelUploaderProps) {
  const [manualName, setManualName] = useState("");
  const [extracting, setExtracting] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setPreviewUrl(URL.createObjectURL(file));
    setExtracting(true);

    try {
      const result = await extractLabel(file);

      if (result.confidence === "low" || !result.product_name) {
        toast.warning("Could not read label clearly. Please enter the product name manually.");
        return;
      }

      if (result.confidence === "medium") {
        toast.info(`Extracted: "${result.product_name}" — please confirm this is correct.`);
      }

      if (result.product_name) {
        setManualName(result.product_name);
        onExtracted(result.product_name);
      }
    } catch (err: any) {
      toast.error(err.message || "Label extraction failed.");
    } finally {
      setExtracting(false);
    }
  }

  function handleManualSubmit() {
    const trimmed = manualName.trim();
    if (!trimmed) {
      toast.error("Please enter a product name.");
      return;
    }
    onExtracted(trimmed);
  }

  return (
    <div className="space-y-5">
      {/* Photo upload */}
      <div className="space-y-2">
        <Label className="text-sm font-medium text-gray-700">
          Upload a label photo
        </Label>
        <div
          onClick={() => fileRef.current?.click()}
          className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center cursor-pointer hover:border-[#1A3D2B] transition-colors"
        >
          {previewUrl ? (
            <img
              src={previewUrl}
              alt="Label preview"
              className="max-h-40 mx-auto rounded object-contain"
            />
          ) : (
            <p className="text-sm text-gray-400">
              Click to upload a photo of the fertilizer label
            </p>
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={handleFileChange}
          title="Upload fertilizer label photo"
          aria-label="Upload fertilizer label photo"
        />
        {extracting && (
          <p className="text-xs text-gray-500 animate-pulse">Reading label...</p>
        )}
      </div>

      {/* Divider */}
      <div className="flex items-center gap-3">
        <div className="flex-1 h-px bg-gray-200" />
        <span className="text-xs text-gray-400">or enter manually</span>
        <div className="flex-1 h-px bg-gray-200" />
      </div>

      {/* Manual entry */}
      <div className="space-y-2">
        <Label htmlFor="product-name" className="text-sm font-medium text-gray-700">
          Product name
        </Label>
        <Input
          id="product-name"
          placeholder="e.g. Minjingu Mazao"
          value={manualName}
          onChange={(e) => setManualName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleManualSubmit()}
          disabled={isLoading || extracting}
        />
      </div>

      <Button
        onClick={handleManualSubmit}
        disabled={isLoading || extracting || !manualName.trim()}
        className="w-full bg-[#1A3D2B] hover:bg-[#142e20] text-white"
      >
        {isLoading ? "Checking..." : "Check this product"}
      </Button>
    </div>
  );
}