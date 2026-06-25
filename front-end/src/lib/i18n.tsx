// Lightweight i18n for SmartExports — English + Swahili.
// No external dep; typed dictionary + React context.

/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type Lang = "en" | "sw";
const STORAGE_KEY = "smartexports.lang";

type Dict = {
  topbar: { startOver: string; switchTo: string };
  footer: { region: string; tag: string };
  intro: {
    kicker: string;
    h1a: string;
    h1b: string;
    h1c: string;
    lede: string;
    bullets: { title: string; body: string }[];
    cta: string;
    note: string;
    samplesTitle: string;
  };
  capture: {
    kicker: string;
    h2: string;
    lede: string;
    frameHint: string;
    openCamera: string;
    back: string;
    upload: string;
    shoot: string;
    close: string;
    torchOn: string;
    torchOff: string;
    cameraDenied: string;
  };
  history: { title: string; clear: string; empty: string; ago: (s: string) => string };
  confirm: {
    kicker: string;
    h2: string;
    retake: string;
    productLabel: string;
    productPlaceholder: string;
    reading: string;
    cropLabel: string;
    alsoSeen: string;
    cta: string;
    confidence: Record<"high" | "medium" | "low", { label: string; body: string }>;
  };
  loading: { title: (p: string, c: string) => string; steps: string[]; waking: string };
  result: {
    kicker: string;
    verdict: { Safe: string; Risky: string; Unclear: string };
    nextStep: Record<"Safe" | "Risky" | "Unclear", string>;
    localizedExplanation: Record<
      "Safe" | "Risky" | "Unclear",
      (p: string, c: string, substance: string | null, regulation: string | null) => string
    >;
    unknownProduct: string;
    unknownExplanation: (p: string, c: string) => string;
    flaggedLabel: string;
    containsLabel: string;
    regulationLabel: string;
    limitLabel: string;
    detailsTitle: string;
    rejectionLabel: string;
    rejectionNo: string;
    organicLabel: string;
    nextLabel: string;
    altLabel: string;
    consider: (product: string) => string;
    altSub: (crop: string) => string;
    matchLabel: string;
    matchFuzzy: string;
    matchExact: string;
    matchReview: string;
    again: string;
    expertReview: string;
    flag: string;
    share: string;
    shareText: (p: string, c: string, verdict: string, expl: string) => string;
  };
  escalate: {
    kicker: string;
    h2: string;
    lede: (p: string) => string;
    contactLabel: string;
    contactPh: string;
    notesLabel: string;
    notesPh: string;
    cta: string;
    sending: string;
    cancel: string;
    doneTitle: string;
    doneBody: (p: string, c: string) => string;
    done: string;
    ticketLabel: string;
    ticketHint: string;
    copy: string;
    copied: string;
  };
  errors: { ocrEmpty: string; ocrFail: string; generic: string; sendFail: string; network: string };
};

const en: Dict = {
  topbar: { startOver: "Start over", switchTo: "Swahili" },
  footer: { region: "EU compliance · Kenya", tag: "Grounded in real rejection cases" },
  intro: {
    kicker: "Begin",
    h1a: "Is your fertilizer",
    h1b: "EU-safe",
    h1c: "for export?",
    lede: "Snap the label. We check it against EU rules and real shipment rejections — then return a plain verdict in seconds.",
    bullets: [
      { title: "Photograph the label", body: "Front of the bag, clear light." },
      { title: "Tell us the crop", body: "Tea, coffee, avocado…" },
      { title: "Read the verdict", body: "Safe · Risky · Unclear, with reasoning." },
    ],
    cta: "Start a check",
    note: "Takes about 20 seconds",
    samplesTitle: "Try a sample",
  },
  capture: {
    kicker: "Photograph",
    h2: "Show us the label.",
    lede: "Hold the bag steady. Fill the frame with the front of the label so the product name is readable.",
    frameHint: "Frame here",
    openCamera: "Open camera",
    back: "← Back",
    upload: "Upload from gallery",
    shoot: "Capture",
    close: "Close",
    torchOn: "Torch on",
    torchOff: "Torch off",
    cameraDenied: "Camera unavailable. Upload a photo from your gallery instead.",
  },
  history: {
    title: "Recently checked",
    clear: "Clear",
    empty: "No checks yet.",
    ago: (s) => `${s} ago`,
  },
  confirm: {
    kicker: "Confirm",
    h2: "Confirm what we read.",
    retake: "Retake photo",
    productLabel: "Product on label",
    productPlaceholder: "e.g. Mavuno Planting",
    reading: "Reading label",
    cropLabel: "Crop you're growing for export",
    alsoSeen: "Also seen on the label",
    cta: "Check compliance",
    confidence: {
      high: {
        label: "High confidence",
        body: "We read the product clearly. Pick the crop and we will check it automatically.",
      },
      medium: {
        label: "Medium confidence",
        body: "Check the extracted name before continuing. Edit it if the label was read wrongly.",
      },
      low: {
        label: "Low confidence",
        body: "We could not read this label clearly. Type the product name from the label.",
      },
    },
  },
  loading: {
    title: (p, c) => `Checking ${p} for ${c}…`,
    steps: [
      "Resolving product name",
      "Matching against EU regulations",
      "Searching rejection cases",
      "Composing verdict",
    ],
    waking: "Server is waking up — first check of the day takes a bit longer.",
  },
  result: {
    kicker: "Verdict",
    verdict: { Safe: "Safe", Risky: "Risky", Unclear: "Unclear" },
    nextStep: {
      Safe: "Proceed with application as planned. Keep the label and batch record with your farm notes.",
      Risky:
        "Avoid this product for export-bound crops. Use the suggested alternative or request expert review.",
      Unclear: "Do not assume safety. Send this product for expert review before applying.",
    },
    localizedExplanation: {
      Safe: (p, c) =>
        `The current dataset does not show an EU restriction or Kenyan rejection case for ${p} on ${c}. Keep the label and follow the recommended rate.`,
      Risky: (p, c, substance, regulation) =>
        `${p} is flagged as Risky for ${c}${substance ? ` because it contains ${substance}` : ""}${regulation ? ` under ${regulation}` : ""}. Do not apply it to export-bound ${c} until an agronomist confirms it is acceptable.`,
      Unclear: (p, c) =>
        `We do not have enough trusted data for ${p} on ${c}. Treat it as Unclear and request expert review before using it on export crops.`,
    },
    unknownProduct: "Unknown product",
    unknownExplanation: (p, c) =>
      `${p} is not in the current compliance dataset for ${c}. This does not prove it is safe, so treat it as Unclear and send it for expert review.`,
    flaggedLabel: "Flagged evidence",
    containsLabel: "Contains",
    regulationLabel: "Regulation",
    limitLabel: "EU limit",
    detailsTitle: "See details",
    rejectionLabel: "Rejection case",
    rejectionNo: "No rejection case is linked in the current evidence.",
    organicLabel: "Organic restriction",
    nextLabel: "What to do next",
    altLabel: "Suggested alternative",
    consider: (product) => `Consider: ${product} instead`,
    altSub: (crop) => `A product with comparable nutrition that fits EU rules for ${crop}.`,
    matchLabel: "Match",
    matchFuzzy: "Matched by fuzzy spelling",
    matchExact: "Exact match in dataset",
    matchReview: "Needs expert review",
    again: "Check another product",
    expertReview: "Get expert review",
    flag: "Flag this verdict for expert review",
    share: "Share on WhatsApp",
    shareText: (p, c, v, e) =>
      `SmartExports verdict — ${p} on ${c}: ${v.toUpperCase()}.\n\n${e}\n\nCheck your own at smartexports.app`,
  },
  escalate: {
    kicker: "Not in dataset",
    h2: "We don't know this one yet.",
    lede: (p) =>
      `${p || "This product"} isn't in our compliance graph. Send it to an agronomist for expert review — we'll add it for future farmers.`,
    contactLabel: "Your phone or email (optional)",
    contactPh: "+254… or you@example.com",
    notesLabel: "Anything we should know? (optional)",
    notesPh: "Where you bought it, batch numbers, what's on the back of the label…",
    cta: "Send for review",
    sending: "Sending…",
    cancel: "Cancel",
    doneTitle: "Sent to expert review.",
    doneBody: (p, c) =>
      `Our team will look into ${p} for ${c} and follow up if you left contact details.`,
    done: "Done",
    ticketLabel: "Your reference",
    ticketHint: "Save this. Quote it if you contact us about this product.",
    copy: "Copy",
    copied: "Copied",
  },
  errors: {
    ocrEmpty: "We couldn't read the product name. Type it from the label.",
    ocrFail: "Could not read the label. Type the product name below.",
    generic: "Something went wrong. Please retry.",
    sendFail: "Could not send. Please retry.",
    network: "Could not reach the server. Check your connection and try again.",
  },
};

const sw: Dict = {
  topbar: { startOver: "Anza upya", switchTo: "English" },
  footer: { region: "Sheria za EU · Kenya", tag: "Imejengwa kwa kesi halisi za kukataliwa" },
  intro: {
    kicker: "Anza",
    h1a: "Je, mbolea yako ni",
    h1b: "salama EU",
    h1c: "kwa kuuza nje?",
    lede: "Piga picha ya lebo. Tutaiangalia dhidi ya sheria za EU na shehena zilizokataliwa — kisha tukurudishie jibu wazi ndani ya sekunde.",
    bullets: [
      { title: "Piga picha ya lebo", body: "Mbele ya mfuko, mwanga ulio wazi." },
      { title: "Tuambie zao lako", body: "Chai, kahawa, parachichi…" },
      { title: "Soma jibu", body: "Salama · Hatari · Si Wazi, na sababu." },
    ],
    cta: "Anza ukaguzi",
    note: "Inachukua takriban sekunde 20",
    samplesTitle: "Jaribu mfano",
  },
  capture: {
    kicker: "Picha",
    h2: "Tuonyeshe lebo.",
    lede: "Shika mfuko vizuri. Jaza fremu na sehemu ya mbele ya lebo ili jina la bidhaa lisomeke.",
    frameHint: "Weka hapa",
    openCamera: "Fungua kamera",
    back: "← Rudi",
    upload: "Pakia kutoka kwenye picha",
    shoot: "Piga",
    close: "Funga",
    torchOn: "Tochi imewaka",
    torchOff: "Tochi imezimwa",
    cameraDenied: "Kamera haipatikani. Tumia picha kutoka kwenye gallery.",
  },
  history: {
    title: "Ukaguzi wa hivi karibuni",
    clear: "Futa",
    empty: "Hakuna ukaguzi bado.",
    ago: (s) => `${s} zilizopita`,
  },
  confirm: {
    kicker: "Thibitisha",
    h2: "Thibitisha tulichosoma.",
    retake: "Piga picha tena",
    productLabel: "Bidhaa kwenye lebo",
    productPlaceholder: "k.m. Mavuno Planting",
    reading: "Inasoma lebo",
    cropLabel: "Zao unalolima kwa kuuza nje",
    alsoSeen: "Pia tumeona kwenye lebo",
    cta: "Kagua uzingatiaji",
    confidence: {
      high: {
        label: "Uhakika mkubwa",
        body: "Tumesoma bidhaa vizuri. Chagua zao kisha tutaikagua moja kwa moja.",
      },
      medium: {
        label: "Uhakika wa kati",
        body: "Angalia jina tulilosoma kabla ya kuendelea. Lirekebishe kama si sahihi.",
      },
      low: {
        label: "Uhakika mdogo",
        body: "Hatukuweza kusoma lebo vizuri. Andika jina la bidhaa kutoka kwenye lebo.",
      },
    },
  },
  loading: {
    title: (p, c) => `Inaangalia ${p} kwa ${c}…`,
    steps: [
      "Inatambua jina la bidhaa",
      "Inalinganisha na sheria za EU",
      "Inatafuta kesi za kukataliwa",
      "Inaandaa jibu",
    ],
    waking: "Seva inaamka — ukaguzi wa kwanza wa siku huchukua muda kidogo.",
  },
  result: {
    kicker: "Jibu",
    verdict: { Safe: "Salama", Risky: "Hatari", Unclear: "Si Wazi" },
    nextStep: {
      Safe: "Endelea kutumia kama ulivyopanga. Hifadhi lebo na kumbukumbu za shamba.",
      Risky:
        "Usitumie bidhaa hii kwa mazao ya kuuza nje. Tumia mbadala uliopendekezwa au omba ukaguzi wa mtaalamu.",
      Unclear: "Usidhani ni salama. Itume kwa mtaalamu kabla ya kuitumia.",
    },
    localizedExplanation: {
      Safe: (p, c) =>
        `Data tuliyo nayo haionyeshi kizuizi cha EU au kesi ya kukataliwa kwa ${p} kwenye ${c}. Hifadhi lebo na fuata kiwango kilichoelekezwa.`,
      Risky: (p, c, substance, regulation) =>
        `${p} imeonekana kuwa Hatari kwa ${c}${substance ? ` kwa sababu ina ${substance}` : ""}${regulation ? ` chini ya ${regulation}` : ""}. Usiitumie kwa ${c} ya kuuza nje mpaka mtaalamu athibitishe.`,
      Unclear: (p, c) =>
        `Hatuna data ya kutosha kuhusu ${p} kwenye ${c}. Ichukulie kama Si Wazi na omba ukaguzi wa mtaalamu kabla ya kuitumia.`,
    },
    unknownProduct: "Bidhaa isiyojulikana",
    unknownExplanation: (p, c) =>
      `${p} haipo kwenye data yetu ya ${c}. Hii haimaanishi ni salama, kwa hivyo ichukulie kama Si Wazi na itume kwa mtaalamu.`,
    flaggedLabel: "Ushahidi uliopatikana",
    containsLabel: "Ina",
    regulationLabel: "Sheria",
    limitLabel: "Kiwango cha EU",
    detailsTitle: "Ona maelezo",
    rejectionLabel: "Kesi ya kukataliwa",
    rejectionNo: "Hakuna kesi ya kukataliwa iliyounganishwa kwenye ushahidi huu.",
    organicLabel: "Kizuizi cha kilimo hai",
    nextLabel: "Hatua inayofuata",
    altLabel: "Mbadala iliyopendekezwa",
    consider: (product) => `Fikiria kutumia: ${product}`,
    altSub: (crop) => `Bidhaa yenye virutubisho sawa inayokidhi sheria za EU kwa ${crop}.`,
    matchLabel: "Mlinganisho",
    matchFuzzy: "Imelinganishwa kwa tahajia",
    matchExact: "Mlinganisho sahihi kwenye data",
    matchReview: "Inahitaji ukaguzi wa mtaalamu",
    again: "Kagua bidhaa nyingine",
    expertReview: "Pata ukaguzi wa mtaalamu",
    flag: "Tuma jibu hili kwa mtaalamu",
    share: "Shiriki kwenye WhatsApp",
    shareText: (p, c, v, e) =>
      `Jibu la SmartExports — ${p} kwa ${c}: ${v.toUpperCase()}.\n\n${e}\n\nJikague mwenyewe smartexports.app`,
  },
  escalate: {
    kicker: "Haipo kwenye data",
    h2: "Hatuijui hii bado.",
    lede: (p) =>
      `${p || "Bidhaa hii"} haipo kwenye grafu yetu. Ituma kwa mtaalamu wa kilimo — tutaiongeza kwa wakulima wajao.`,
    contactLabel: "Simu au barua pepe yako (hiari)",
    contactPh: "+254… au wewe@mfano.com",
    notesLabel: "Kitu chochote tujue? (hiari)",
    notesPh: "Ulinunua wapi, nambari za kundi, kilicho nyuma ya lebo…",
    cta: "Tuma kwa ukaguzi",
    sending: "Inatuma…",
    cancel: "Ghairi",
    doneTitle: "Imetumwa kwa ukaguzi.",
    doneBody: (p, c) => `Timu yetu itaichunguza ${p} kwa ${c} na kukufuatilia ukiacha mawasiliano.`,
    done: "Imekamilika",
    ticketLabel: "Kumbukumbu yako",
    ticketHint: "Hifadhi hii. Itaje ukiwasiliana nasi kuhusu bidhaa hii.",
    copy: "Nakili",
    copied: "Imenakiliwa",
  },
  errors: {
    ocrEmpty: "Hatukuweza kusoma jina la bidhaa. Liandike kutoka kwenye lebo.",
    ocrFail: "Hatukuweza kusoma lebo. Andika jina la bidhaa hapa chini.",
    generic: "Kuna hitilafu. Tafadhali jaribu tena.",
    sendFail: "Haikuweza kutuma. Tafadhali jaribu tena.",
    network: "Hatuwezi kufikia seva. Angalia muunganisho wako na ujaribu tena.",
  },
};

const DICTS: Record<Lang, Dict> = { en, sw };

type Ctx = { lang: Lang; t: Dict; setLang: (l: Lang) => void };
const LangCtx = createContext<Ctx | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>("en");
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY) as Lang | null;
      if (saved === "en" || saved === "sw") setLangState(saved);
      else if (
        typeof navigator !== "undefined" &&
        navigator.language?.toLowerCase().startsWith("sw")
      ) {
        setLangState("sw");
      }
    } catch {
      /* ignore */
    }
  }, []);
  const setLang = (l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* ignore */
    }
    if (typeof document !== "undefined") document.documentElement.lang = l;
  };
  return <LangCtx.Provider value={{ lang, t: DICTS[lang], setLang }}>{children}</LangCtx.Provider>;
}

export function useI18n(): Ctx {
  const ctx = useContext(LangCtx);
  if (!ctx) throw new Error("useI18n must be used inside <LanguageProvider>");
  return ctx;
}
