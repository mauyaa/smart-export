"use client";

import { Label } from "@/components/ui/label";

interface CropSelectorProps {
  value: string;
  onChange: (crop: string) => void;
  disabled?: boolean;
}

const CROPS = [
  "French beans",
  "Snow peas",
  "Mange tout",
  "Baby corn",
  "Avocado",
  "Passion fruit",
  "Mango",
  "Macadamia",
  "Coffee",
  "Tea",
  "Pyrethrum",
  "Roses",
  "Carnations",
];

export default function CropSelector({ value, onChange, disabled }: CropSelectorProps) {
  return (
    <div className="space-y-2">
      <Label htmlFor="crop" className="text-sm font-medium text-gray-700">
        Crop
      </Label>
      <select
        id="crop"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        title="Select a crop"
        aria-label="Select a crop"
        className="w-full rounded-md border border-input bg-white px-3 py-2 text-sm text-gray-700 shadow-sm focus:outline-none focus:ring-2 focus:ring-[#1A3D2B] disabled:opacity-50"
      >
        <option value="" disabled>
          Select a crop
        </option>
        {CROPS.map((crop) => (
          <option key={crop} value={crop}>
            {crop}
          </option>
        ))}
      </select>
    </div>
  );
}