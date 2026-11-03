import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { en } from "./en";
import { ru } from "./ru";
import type { CommandError } from "../lib/tauri";

const STORAGE_KEY = "untrace.language";

export const languages = ["ru", "en"] as const;
export type Language = (typeof languages)[number];

export const resources = {
  ru: { translation: ru },
  en: { translation: en },
} as const;

type PluralSuffix = "one" | "few" | "many" | "other";
type BaseKey<K> = K extends `${infer Base}_${PluralSuffix}` ? Base : K;
type MessageKeys<M> = BaseKey<keyof M>;
// Fails to compile when one language is missing a message the other has.
type NoGap<T extends never> = T;
export type RuHasEverything = NoGap<Exclude<MessageKeys<typeof en>, MessageKeys<typeof ru>>>;
export type EnHasEverything = NoGap<Exclude<MessageKeys<typeof ru>, MessageKeys<typeof en>>>;
// Fails to compile when an error code the backend sends has no sentence.
export type EveryErrorIsWorded = NoGap<Exclude<`errors.${CommandError["code"]}`, MessageKeys<typeof en>>>;

function initialLanguage(): Language {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "ru" || stored === "en") {
    return stored;
  }
  return navigator.language.toLowerCase().startsWith("ru") ? "ru" : "en";
}

export function setLanguage(language: Language) {
  localStorage.setItem(STORAGE_KEY, language);
  document.documentElement.lang = language;
  void i18n.changeLanguage(language);
}

const language = initialLanguage();
document.documentElement.lang = language;

void i18n.use(initReactI18next).init({
  lng: language,
  fallbackLng: "en",
  resources,
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false },
});

export default i18n;
