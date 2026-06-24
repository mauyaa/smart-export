import { CheckResult, RiskLevel } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

interface ResultCardProps {
  result: CheckResult;
}

const riskConfig: Record<RiskLevel, { border: string; badge: string }> = {
  Safe: {
    border: "border-l-green-600",
    badge: "bg-green-100 text-green-800",
  },
  Risky: {
    border: "border-l-red-600",
    badge: "bg-red-100 text-red-800",
  },
  Unclear: {
    border: "border-l-amber-500",
    badge: "bg-amber-100 text-amber-800",
  },
};

export default function ResultCard({ result }: ResultCardProps) {
  const config = riskConfig[result.risk_level];

  return (
    <Card className={`border-l-4 ${config.border} shadow-md bg-white`}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="text-lg font-semibold text-[#1A3D2B]">
            {result.fertilizer}
          </CardTitle>
          <Badge className={`${config.badge} text-sm px-3 py-1 font-semibold`}>
            {result.risk_level}
          </Badge>
        </div>
        <p className="text-sm text-gray-500">Crop: {result.crop}</p>
      </CardHeader>

      <Separator />

      <CardContent className="pt-4 space-y-4">
        <div>
          <p className="text-sm font-medium text-gray-700 mb-1">Explanation</p>
          <p className="text-sm text-gray-600 leading-relaxed">{result.explanation}</p>
        </div>

        <div>
          <p className="text-sm font-medium text-gray-700 mb-1">Next Step</p>
          <p className="text-sm text-gray-600 leading-relaxed">{result.next_step}</p>
        </div>

        {result.alternative_product && (
          <div>
            <p className="text-sm font-medium text-gray-700 mb-1">Suggested Alternative</p>
            <p className="text-sm text-gray-600">{result.alternative_product}</p>
          </div>
        )}

        {result.matched_via.startsWith("fuzzy") && (
          <p className="text-xs text-gray-400 italic">
            Matched via approximate name — verify product name if unexpected.
          </p>
        )}
      </CardContent>
    </Card>
  );
}