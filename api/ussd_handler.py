CROPS = [
    "French beans", "Avocado", "Snow peas", "Tea", "Coffee",
    "Mango", "Passion fruit", "Macadamia", "Cut Flowers", "Pineapple", "Other",
]

def parse_level(text):
    if not text or text.strip() == "":
        return []
    return [t.strip() for t in text.strip().split("*") if t.strip()]

def handle_ussd(session_id, phone, text, risk_check_fn):
    steps = parse_level(text)
    level = len(steps)

    if level == 0:
        return ("CON Welcome to SmartExports\n"
                "EU compliance for Kenyan farmers\n\n"
                "1. Check a fertilizer\n"
                "2. What is SmartExports?\n"
                "3. Talk to an expert")

    choice = steps[0]

    if choice == "2":
        return ("END SmartExports checks if your\n"
                "fertilizer could block your EU export.\n\n"
                "Type the product name to get a\n"
                "Safe, Risky or Unclear verdict.\n"
                "Dial again to check a product.")

    if choice == "3":
        if level == 1:
            return ("CON Talk to an expert\n\n"
                    "Enter the fertilizer name\n"
                    "you want reviewed:")
        if level == 2:
            return (f"END Request sent for '{steps[1]}'.\n"
                    f"Phone: {phone}\n"
                    f"Our team will follow up\n"
                    f"within 24 hours.")

    if choice == "1":
        if level == 1:
            return ("CON Enter fertilizer/product name:\n"
                    "(e.g. Orthene 75SP)\n\n"
                    "Type name as shown on the bag:")

        fertilizer_name = steps[1]

        if level == 2:
            crop_menu = "\n".join([f"{i+1}. {c}" for i, c in enumerate(CROPS)])
            return (f"CON Product: {fertilizer_name}\n\n"
                    f"Select export crop:\n{crop_menu}")

        if level == 3:
            crop_choice = steps[2]
            try:
                idx = int(crop_choice) - 1
                if idx == len(CROPS) - 1:
                    return "CON Enter your crop name:"
                crop_name = CROPS[idx] if 0 <= idx < len(CROPS) - 1 else crop_choice
            except ValueError:
                crop_name = crop_choice

            result = risk_check_fn(fertilizer_name, crop_name)

            if result is None:
                return (f"CON {fertilizer_name} not in\n"
                        f"our database yet.\n\n"
                        f"0. Send for expert review\n"
                        f"9. Check another product")

            risk = result.get("risk_level", "Unclear")
            alt = result.get("alternative_product")
            resolved = result.get("fertilizer", fertilizer_name)

            if risk == "Safe":
                return (f"END SAFE\n"
                        f"{resolved} + {crop_name}\n\n"
                        f"No EU restrictions found.\n"
                        f"Proceed with application.\n"
                        f"Dial again to check another.")
            elif risk == "Risky":
                alt_line = f"\nAlternative: {alt}" if alt else ""
                return (f"CON RISKY\n"
                        f"{resolved} + {crop_name}\n\n"
                        f"May block EU export.{alt_line}\n\n"
                        f"0. Get expert advice\n"
                        f"9. Check another product")
            else:
                return (f"CON UNCLEAR\n"
                        f"{resolved} + {crop_name}\n\n"
                        f"Not enough data for verdict.\n\n"
                        f"0. Send for expert review\n"
                        f"9. Check another product")

        if level >= 4:
            post = steps[3]
            if post == "9":
                return "CON Enter another fertilizer name:"
            if post == "0":
                try:
                    idx = int(steps[2]) - 1
                    crop_name = CROPS[idx] if 0 <= idx < len(CROPS) - 1 else steps[2]
                except ValueError:
                    crop_name = steps[2]
                return (f"END Sent for expert review.\n\n"
                        f"Product: {steps[1]}\n"
                        f"Crop: {crop_name}\n"
                        f"Phone: {phone}\n\n"
                        f"Agronomist will contact\n"
                        f"you within 24 hours.")

    return "END Invalid input. Please dial again."
