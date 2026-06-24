"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { escalate } from "@/lib/api";
import { toast } from "sonner";

interface EscalateFormProps {
  fertilizerName: string;
  cropName: string;
  onDone: () => void;
}

export default function EscalateForm({
  fertilizerName,
  cropName,
  onDone,
}: EscalateFormProps) {
  const [contact, setContact] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  async function handleSubmit() {
    setSubmitting(true);
    try {
      await escalate(fertilizerName, cropName, contact || undefined, notes || undefined);
      setSubmitted(true);
      toast.success("Request logged. An agronomist will review it.");
    } catch (err: any) {
      toast.error(err.message || "Escalation failed. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <Card className="border-l-4 border-l-amber-500 bg-white shadow-md">
        <CardContent className="pt-6 space-y-3">
          <p className="text-sm font-semibold text-amber-700">Request received</p>
          <p className="text-sm text-gray-600">
            <span className="font-medium">{fertilizerName}</span> has been flagged for
            expert review. Do not apply this product to export-bound crops until you
            receive confirmation.
          </p>
          <Button
            variant="outline"
            className="w-full mt-2"
            onClick={onDone}
          >
            Check another product
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-l-4 border-l-amber-500 bg-white shadow-md">
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-semibold text-[#1A3D2B]">
          Product not in our dataset
        </CardTitle>
        <p className="text-sm text-gray-500">
          <span className="font-medium">{fertilizerName}</span> was not found. Flag it
          for expert review and we will check its EU compliance status.
        </p>
      </CardHeader>

      <CardContent className="space-y-4 pt-2">
        <div className="space-y-2">
          <Label htmlFor="contact" className="text-sm font-medium text-gray-700">
            Your contact (optional)
          </Label>
          <Input
            id="contact"
            placeholder="Phone number or email"
            value={contact}
            onChange={(e) => setContact(e.target.value)}
            disabled={submitting}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="notes" className="text-sm font-medium text-gray-700">
            Notes (optional)
          </Label>
          <Input
            id="notes"
            placeholder="e.g. bought from Eldoret agro-dealer, used on French beans"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            disabled={submitting}
          />
        </div>

        <div className="flex gap-3">
          <Button
            onClick={handleSubmit}
            disabled={submitting}
            className="flex-1 bg-[#D4880A] hover:bg-[#b8740a] text-white"
          >
            {submitting ? "Submitting..." : "Flag for review"}
          </Button>
          <Button
            variant="outline"
            onClick={onDone}
            disabled={submitting}
            className="flex-1"
          >
            Cancel
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}