import { useTranslation } from "react-i18next";
import { ITEM_SUBTYPES, isItemSubtype, type ItemSubtype } from "./tauri";

interface Described {
  subtype: string | null;
  text: string | null;
  /// Stands in for missing text, as Telegram's chat list does.
  file_name: string | null;
}

/// Close enough to the store's search folding for the short subtype labels.
function fold(text: string) {
  return text.normalize("NFC").toLowerCase().replaceAll("ё", "е");
}

/// Words a row the way Telegram does: what it is, then its own text or else its
/// file's name ("Poll: tea or coffee", "File: report.pdf"). Plain text shows as it is.
export function useItemText() {
  const { t } = useTranslation();
  return ({ subtype, text: ownText, file_name }: Described) => {
    const text = ownText ?? file_name;
    if (!subtype) {
      return text ?? t("preview.noText");
    }
    // A subtype newer than this interface reads as a service message.
    const label = t(`subtypes.${isItemSubtype(subtype) ? subtype : "service"}`);
    return text ? t("preview.subtypeWithText", { subtype: label, text }) : label;
  };
}

/// The subtypes whose label, in the interface language, holds the search, so the
/// store can find rows by what they are as well as by their text.
export function useSubtypesNamedBy(search: string): ItemSubtype[] {
  const { t } = useTranslation();
  const needle = fold(search.trim());
  return needle ? ITEM_SUBTYPES.filter((subtype) => fold(t(`subtypes.${subtype}`)).includes(needle)) : [];
}
